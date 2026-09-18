// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IFacilityAdapter } from "./IFacilityAdapter.sol";
import { IERC20 } from "./IERC20.sol";
import { ILiquidityFacility } from "./ILiquidityFacility.sol";

interface IERC20Approval is IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract LiquidityFacility is ILiquidityFacility {
    uint256 public constant WAD = 1e18;
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;

    address public immutable override asset;
    address public immutable admin;
    address public immutable curator;
    address public immutable override executor;
    address public immutable guardian;

    uint256 public override haircutWad;
    bool public paused;
    bool public quotePaused;
    address public router;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    mapping(address => bool) public adapterAllowed;
    mapping(address => bool) public adapterRegistered;
    address[] public adapters;

    struct WithdrawRequest {
        address owner;
        uint256 assets;
        uint256 shares;
    }

    mapping(uint256 => WithdrawRequest) public withdrawRequests;
    uint256 public nextRequestId = 1;
    uint256 public queueHead = 1;
    uint256 public reservedQueueAssets;
    uint256 public pendingFundedUsdc;
    uint256 public pendingFundedBlock;
    uint256 public inventoryAtAcquisitionCost;

    struct InventoryLot {
        address token;
        uint256 amount;
        uint256 usdcPaid;
    }

    InventoryLot[] public inventoryLots;
    /// Unbooked inventory is tracked separately from the immutable lot record.
    /// This prevents a curator from booking the same acquired stock twice.
    mapping(uint256 => uint256) public inventoryRemaining;
    mapping(uint256 => uint256) public inventoryRemainingCost;
    uint256 public nextLotId;
    uint256 public constant DEFAULT_QUOTE_MAX_AGE = 300;

    /// Stock pricing and redemption controls. Prices are USDC base units per
    /// stock base unit scaled by 1e18; the multiplier tracks B20 corporate
    /// actions and is deliberately read at quote time.
    mapping(address => uint256) public stockPriceWad;
    mapping(address => uint256) public stockPriceUpdatedAt;
    mapping(address => uint256) public stockPriceMaxAge;
    mapping(address => uint256) public stockMultiplierWad;
    mapping(address => uint256) public stockExposure;
    mapping(address => uint256) public stockExposureCap;
    mapping(address => address) public redemptionOperator;
    mapping(address => bool) public redemptionPath;
    uint256 public realizedProfit;
    uint256 public realizedLoss;

    struct RedemptionLot {
        address token;
        uint256 amount;
        uint256 acquisitionCost;
        address operator;
        bool settled;
    }

    mapping(uint256 => RedemptionLot) public redemptionLots;
    uint256 public nextRedemptionLotId;
    uint256 private _status = 1;

    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );
    event WithdrawQueued(
        address indexed owner, uint256 indexed requestId, uint256 assets, uint256 shares
    );
    event WithdrawClaimed(address indexed owner, uint256 indexed requestId, uint256 assets);
    event VenueAllocation(address indexed adapter, uint256 assets, bool allocating);
    event InventoryAcquired(address indexed token, uint256 amount, uint256 usdcPaid);
    event StockPriceUpdated(address indexed token, uint256 priceWad, uint256 updatedAt);
    event StockMultiplierUpdated(address indexed token, uint256 multiplierWad);
    event StockExposureCapUpdated(address indexed token, uint256 cap);
    event RedemptionPathUpdated(address indexed token, address indexed operator, bool enabled);
    event RedemptionLotBooked(uint256 indexed lotId, address indexed token, uint256 amount, uint256 acquisitionCost, address operator);
    event RedemptionSettled(uint256 indexed lotId, uint256 usdcProceeds, int256 realizedPnl);

    modifier onlyCurator() {
        require(msg.sender == curator, "UNAUTHORIZED");
        _;
    }

    modifier onlyAdminOrGuardian() {
        require(msg.sender == admin || msg.sender == guardian, "UNAUTHORIZED");
        _;
    }

    modifier nonReentrant() {
        require(_status == 1, "REENTRANT");
        _status = 2;
        _;
        _status = 1;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(address asset_, address curator_, address executor_, address guardian_) {
        require(asset_ != address(0), "INVALID_ASSET");
        require(asset_ != USDBC, "UNSUPPORTED_ASSET");
        require(
            curator_ != address(0) && executor_ != address(0) && guardian_ != address(0),
            "INVALID_ROLE"
        );
        asset = asset_;
        admin = msg.sender;
        curator = curator_;
        executor = executor_;
        guardian = guardian_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 allowed = allowance[owner][msg.sender];
        require(allowed >= amount, "INSUFFICIENT_ALLOWANCE");
        allowance[owner][msg.sender] = allowed - amount;
        _transfer(owner, recipient, amount);
        return true;
    }

    function totalAssets() public view returns (uint256) {
        uint256 gross = _grossAssets();
        return gross > reservedQueueAssets ? gross - reservedQueueAssets : 0;
    }

    function idleAssets() public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 freeShares = _freeShares();
        uint256 freeAssets = totalAssets();
        if (freeShares == 0 || freeAssets == 0) return assets;
        return assets * freeShares / freeAssets;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 freeShares = _freeShares();
        if (freeShares == 0) return 0;
        return shares * totalAssets() / freeShares;
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 freeShares = _freeShares();
        uint256 freeAssets = totalAssets();
        if (freeShares == 0 || freeAssets == 0) return assets;
        return (assets * freeShares + freeAssets - 1) / freeAssets;
    }

    function deposit(uint256 assets, address receiver)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        require(assets != 0 && receiver != address(0), "INVALID_AMOUNT");
        shares = convertToShares(assets);
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED"
        );
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        require(assets != 0 && receiver != address(0) && owner != address(0), "INVALID_AMOUNT");
        require(_withdrawable() >= assets, "ILLIQUID");
        shares = previewWithdraw(assets);
        require(balanceOf[owner] >= shares, "INSUFFICIENT_SHARES");
        _spendAllowance(owner, shares);
        _ensureIdle(assets);
        _burn(owner, shares);
        require(IERC20(asset).transfer(receiver, assets), "ASSET_TRANSFER_FAILED");
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function requestWithdraw(uint256 assets)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 requestId)
    {
        require(assets != 0, "INVALID_AMOUNT");
        uint256 shares = previewWithdraw(assets);
        require(balanceOf[msg.sender] >= shares, "INSUFFICIENT_SHARES");
        _transfer(msg.sender, address(this), shares);
        requestId = nextRequestId++;
        withdrawRequests[requestId] =
            WithdrawRequest({ owner: msg.sender, assets: assets, shares: shares });
        reservedQueueAssets += assets;
        emit WithdrawQueued(msg.sender, requestId, assets, shares);
    }

    function claimWithdraw(uint256 requestId)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 assets)
    {
        require(requestId == queueHead, "NOT_QUEUE_HEAD");
        WithdrawRequest memory request = withdrawRequests[requestId];
        require(request.owner == msg.sender, "UNAUTHORIZED");
        _ensureIdle(request.assets);
        _burn(address(this), request.shares);
        reservedQueueAssets -= request.assets;
        delete withdrawRequests[requestId];
        queueHead++;
        require(IERC20(asset).transfer(request.owner, request.assets), "ASSET_TRANSFER_FAILED");
        emit WithdrawClaimed(request.owner, requestId, request.assets);
        return request.assets;
    }

    function setAdapterAllowed(address adapter, bool allowed) external onlyCurator {
        require(adapter != address(0), "INVALID_ADAPTER");
        if (allowed && !adapterRegistered[adapter]) {
            require(IFacilityAdapter(adapter).asset() == asset, "ASSET_MISMATCH");
            adapters.push(adapter);
            adapterRegistered[adapter] = true;
        }
        adapterAllowed[adapter] = allowed;
    }

    function allocate(address adapter, uint256 assets)
        external
        onlyCurator
        whenNotPaused
        nonReentrant
    {
        require(adapterAllowed[adapter], "ADAPTER_NOT_ALLOWED");
        require(assets != 0 && idleAssets() >= assets, "ILLIQUID");
        require(IERC20Approval(asset).approve(adapter, assets), "APPROVAL_FAILED");
        uint256 beforeIdle = idleAssets();
        IFacilityAdapter(adapter).deposit(assets);
        require(IERC20Approval(asset).approve(adapter, 0), "APPROVAL_FAILED");
        uint256 afterIdle = idleAssets();
        require(beforeIdle >= afterIdle && beforeIdle - afterIdle >= assets, "ALLOCATE_SHORTFALL");
        emit VenueAllocation(adapter, assets, true);
    }

    function deallocate(address adapter, uint256 assets)
        external
        onlyCurator
        whenNotPaused
        nonReentrant
    {
        require(adapterAllowed[adapter], "ADAPTER_NOT_ALLOWED");
        require(assets != 0, "INVALID_AMOUNT");
        uint256 beforeIdle = idleAssets();
        IFacilityAdapter(adapter).withdraw(assets, address(this));
        uint256 afterIdle = idleAssets();
        require(afterIdle >= beforeIdle, "DEALLOCATE_BALANCE");
        uint256 returned = afterIdle - beforeIdle;
        require(returned >= assets, "DEALLOCATE_SHORTFALL");
        emit VenueAllocation(adapter, returned, false);
    }

    function setHaircutWad(uint256 haircutWad_) external onlyCurator {
        require(haircutWad_ <= WAD, "INVALID_HAIRCUT");
        haircutWad = haircutWad_;
    }

    function setQuotePaused(bool paused_) external onlyCurator {
        quotePaused = paused_;
    }

    function setStockPrice(address token, uint256 priceWad_) external onlyCurator {
        require(token != address(0) && token != asset && priceWad_ != 0, "INVALID_PRICE");
        stockPriceWad[token] = priceWad_;
        stockPriceUpdatedAt[token] = block.timestamp;
        if (stockPriceMaxAge[token] == 0) stockPriceMaxAge[token] = DEFAULT_QUOTE_MAX_AGE;
        if (stockMultiplierWad[token] == 0) stockMultiplierWad[token] = WAD;
        emit StockPriceUpdated(token, priceWad_, block.timestamp);
    }

    function setStockPriceMaxAge(address token, uint256 maxAge) external onlyCurator {
        require(maxAge != 0, "INVALID_MAX_AGE");
        stockPriceMaxAge[token] = maxAge;
    }

    function setStockMultiplier(address token, uint256 multiplierWad_) external onlyCurator {
        require(token != address(0) && multiplierWad_ != 0, "INVALID_MULTIPLIER");
        stockMultiplierWad[token] = multiplierWad_;
        emit StockMultiplierUpdated(token, multiplierWad_);
    }

    function setStockExposureCap(address token, uint256 cap) external onlyCurator {
        require(cap >= stockExposure[token], "EXPOSURE_BELOW_CURRENT");
        stockExposureCap[token] = cap;
        emit StockExposureCapUpdated(token, cap);
    }

    function setRedemptionPath(address token, address operator, bool enabled) external onlyCurator {
        require(token != address(0) && (!enabled || operator != address(0)), "INVALID_REDEMPTION_PATH");
        redemptionOperator[token] = enabled ? operator : address(0);
        redemptionPath[token] = enabled;
        emit RedemptionPathUpdated(token, operator, enabled);
    }

    function quote(address stockToken, uint256 stockAmount)
        public
        view
        override
        returns (uint256 usdcAmount, uint256 capacity, uint256 expiry)
    {
        if (paused || quotePaused || stockToken == address(0) || stockToken == asset || stockAmount == 0) return (0, 0, 0);
        if (!redemptionPath[stockToken] || redemptionOperator[stockToken] == address(0)) return (0, 0, 0);
        uint256 updatedAt = stockPriceUpdatedAt[stockToken];
        uint256 maxAge = stockPriceMaxAge[stockToken];
        if (stockPriceWad[stockToken] == 0 || maxAge == 0 || updatedAt == 0 || block.timestamp > updatedAt + maxAge) return (0, 0, 0);
        uint256 cap = stockExposureCap[stockToken];
        capacity = cap > stockExposure[stockToken] ? cap - stockExposure[stockToken] : 0;
        uint256 multiplier = stockMultiplierWad[stockToken] == 0 ? WAD : stockMultiplierWad[stockToken];
        uint256 price = stockPriceWad[stockToken] * multiplier / WAD;
        price = price * (WAD - haircutWad) / WAD;
        if (price == 0) return (0, 0, updatedAt + maxAge);
        uint256 fundingCapacity = _withdrawable() * WAD / price;
        if (fundingCapacity < capacity) capacity = fundingCapacity;
        if (capacity == 0 || stockAmount > capacity) return (0, capacity, updatedAt + maxAge);
        usdcAmount = stockAmount * price / WAD;
        expiry = updatedAt + maxAge;
    }

    /// Called by the router after it transfers stock into this facility.
    /// The resulting lot is immediately redemption-booked against the
    /// configured AP/vested-holder path.
    function buyStock(address stockToken, uint256 stockAmount, uint256 usdcAmount)
        external
        override
        whenNotPaused
        nonReentrant
        returns (uint256 paidUsdc)
    {
        require(msg.sender == router, "UNAUTHORIZED");
        (uint256 quoted, uint256 capacity, uint256 expiry) = quote(stockToken, stockAmount);
        require(quoted != 0 && capacity >= stockAmount && block.timestamp <= expiry, "QUOTE_UNAVAILABLE");
        require(usdcAmount == quoted, "QUOTE_MISMATCH");
        _ensureIdle(usdcAmount + reservedQueueAssets);
        require(IERC20(asset).transfer(msg.sender, usdcAmount), "ASSET_TRANSFER_FAILED");
        uint256 inventoryLotId = nextLotId++;
        inventoryLots.push(InventoryLot({ token: stockToken, amount: stockAmount, usdcPaid: usdcAmount }));
        // buyStock books the complete lot immediately below, so there is no
        // unassigned inventory left for a second curator booking.
        inventoryRemaining[inventoryLotId] = 0;
        inventoryRemainingCost[inventoryLotId] = 0;
        inventoryAtAcquisitionCost += usdcAmount;
        stockExposure[stockToken] += stockAmount;
        uint256 lotId = nextRedemptionLotId++;
        redemptionLots[lotId] = RedemptionLot({ token: stockToken, amount: stockAmount, acquisitionCost: usdcAmount, operator: redemptionOperator[stockToken], settled: false });
        emit InventoryAcquired(stockToken, stockAmount, usdcAmount);
        emit RedemptionLotBooked(lotId, stockToken, stockAmount, usdcAmount, redemptionOperator[stockToken]);
        return usdcAmount;
    }

    function bookRedemption(uint256 inventoryLotId, uint256 amount) external onlyCurator returns (uint256 redemptionLotId) {
        require(inventoryLotId < inventoryLots.length && amount != 0, "INVALID_REDEMPTION");
        InventoryLot memory lot = inventoryLots[inventoryLotId];
        uint256 remaining = inventoryRemaining[inventoryLotId];
        require(amount <= remaining && redemptionPath[lot.token], "REDEMPTION_UNAVAILABLE");
        uint256 remainingCost = inventoryRemainingCost[inventoryLotId];
        uint256 cost = amount == remaining ? remainingCost : lot.usdcPaid * amount / lot.amount;
        require(cost != 0, "INVALID_REDEMPTION");
        inventoryRemaining[inventoryLotId] = remaining - amount;
        inventoryRemainingCost[inventoryLotId] = remainingCost - cost;
        redemptionLotId = nextRedemptionLotId++;
        redemptionLots[redemptionLotId] = RedemptionLot({ token: lot.token, amount: amount, acquisitionCost: cost, operator: redemptionOperator[lot.token], settled: false });
        emit RedemptionLotBooked(redemptionLotId, lot.token, amount, cost, redemptionOperator[lot.token]);
    }

    function settleRedemption(uint256 redemptionLotId, uint256 usdcProceeds) external nonReentrant returns (int256 realizedPnl) {
        RedemptionLot storage lot = redemptionLots[redemptionLotId];
        require(!lot.settled && lot.operator == msg.sender, "UNAUTHORIZED");
        require(usdcProceeds != 0, "INVALID_PROCEEDS");
        require(IERC20(lot.token).transfer(msg.sender, lot.amount), "STOCK_TRANSFER_FAILED");
        require(IERC20(asset).transferFrom(msg.sender, address(this), usdcProceeds), "ASSET_TRANSFER_FAILED");
        lot.settled = true;
        if (usdcProceeds >= lot.acquisitionCost) {
            realizedPnl = int256(usdcProceeds - lot.acquisitionCost);
            realizedProfit += usdcProceeds - lot.acquisitionCost;
        } else {
            realizedPnl = -int256(lot.acquisitionCost - usdcProceeds);
            realizedLoss += lot.acquisitionCost - usdcProceeds;
        }
        inventoryAtAcquisitionCost = inventoryAtAcquisitionCost >= lot.acquisitionCost ? inventoryAtAcquisitionCost - lot.acquisitionCost : 0;
        stockExposure[lot.token] = stockExposure[lot.token] >= lot.amount ? stockExposure[lot.token] - lot.amount : 0;
        emit RedemptionSettled(redemptionLotId, usdcProceeds, realizedPnl);
    }

    function quoteUsdcCapacity() public view returns (uint256) {
        if (paused || quotePaused) return 0;
        uint256 withdrawable = _withdrawable();
        uint256 quoted = withdrawable * (WAD - haircutWad) / WAD;
        return quoted > withdrawable ? withdrawable : quoted;
    }

    function pause() external onlyAdminOrGuardian {
        paused = true;
    }

    function unpause() external onlyAdminOrGuardian {
        paused = false;
    }

    function setRouter(address router_) external {
        require(msg.sender == admin, "UNAUTHORIZED");
        require(router_ != address(0), "INVALID_ROUTER");
        router = router_;
    }

    function fundLiquidation(uint256 repayAssets, address recipient)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 fundedUsdc)
    {
        require(msg.sender == router, "UNAUTHORIZED");
        require(recipient != address(0) && repayAssets != 0, "INVALID_AMOUNT");
        require(_withdrawable() >= repayAssets, "ILLIQUID");
        _ensureIdle(repayAssets + reservedQueueAssets);
        uint256 idle = idleAssets();
        require(
            idle >= reservedQueueAssets && idle - reservedQueueAssets >= repayAssets, "ILLIQUID"
        );
        require(IERC20(asset).transfer(recipient, repayAssets), "ASSET_TRANSFER_FAILED");
        pendingFundedUsdc = repayAssets;
        pendingFundedBlock = block.number;
        return repayAssets;
    }

    function acquireInventory(address token, uint256 amount, uint256 usdcPaid) external {
        require(msg.sender == router, "UNAUTHORIZED");
        require(block.number == pendingFundedBlock && pendingFundedUsdc != 0, "NO_PENDING_FUND");
        require(usdcPaid != 0 && usdcPaid <= pendingFundedUsdc && amount != 0, "INVALID_AMOUNT");
        require(token != address(0) && token != asset && token != USDBC, "UNSUPPORTED_ASSET");
        uint256 unusedFunding = pendingFundedUsdc - usdcPaid;
        if (unusedFunding != 0) {
            require(
                IERC20(asset).transferFrom(msg.sender, address(this), unusedFunding),
                "REFUND_TRANSFER_FAILED"
            );
        }
        uint256 inventoryLotId = nextLotId++;
        inventoryLots.push(InventoryLot({ token: token, amount: amount, usdcPaid: usdcPaid }));
        inventoryRemaining[inventoryLotId] = amount;
        inventoryRemainingCost[inventoryLotId] = usdcPaid;
        inventoryAtAcquisitionCost += usdcPaid;
        pendingFundedUsdc = 0;
        pendingFundedBlock = 0;
        emit InventoryAcquired(token, amount, usdcPaid);
    }

    function _withdrawable() internal view returns (uint256) {
        uint256 grossWithdrawable = idleAssets();
        for (uint256 i = 0; i < adapters.length; i++) {
            grossWithdrawable += IFacilityAdapter(adapters[i]).maxWithdraw();
        }
        return grossWithdrawable > reservedQueueAssets ? grossWithdrawable - reservedQueueAssets : 0;
    }

    function _grossAssets() internal view returns (uint256 gross) {
        gross = idleAssets();
        for (uint256 i = 0; i < adapters.length; i++) {
            gross += IFacilityAdapter(adapters[i]).totalAssets();
        }
        gross += inventoryAtAcquisitionCost;
    }

    function _freeShares() internal view returns (uint256) {
        uint256 locked = balanceOf[address(this)];
        return totalSupply > locked ? totalSupply - locked : 0;
    }

    function _ensureIdle(uint256 assets) internal {
        uint256 idle = idleAssets();
        if (idle >= assets) return;
        uint256 needed = assets - idle;
        for (uint256 i = 0; i < adapters.length && needed != 0; i++) {
            uint256 available = IFacilityAdapter(adapters[i]).maxWithdraw();
            if (available == 0) continue;
            uint256 amount = available < needed ? available : needed;
            uint256 beforeIdle = idleAssets();
            IFacilityAdapter(adapters[i]).withdraw(amount, address(this));
            uint256 afterIdle = idleAssets();
            require(afterIdle >= beforeIdle, "DEALLOCATE_BALANCE");
            uint256 returned = afterIdle - beforeIdle;
            require(returned >= amount, "DEALLOCATE_SHORTFALL");
            emit VenueAllocation(adapters[i], returned, false);
            needed = returned >= needed ? 0 : needed - returned;
        }
        require(idleAssets() >= assets, "ILLIQUID");
    }

    function _spendAllowance(address owner, uint256 shares) internal {
        if (msg.sender == owner) return;
        uint256 allowed = allowance[owner][msg.sender];
        require(allowed >= shares, "INSUFFICIENT_ALLOWANCE");
        allowance[owner][msg.sender] = allowed - shares;
    }

    function _mint(address owner, uint256 shares) internal {
        totalSupply += shares;
        balanceOf[owner] += shares;
    }

    function _burn(address owner, uint256 shares) internal {
        require(balanceOf[owner] >= shares, "INSUFFICIENT_SHARES");
        balanceOf[owner] -= shares;
        totalSupply -= shares;
    }

    function _transfer(address owner, address recipient, uint256 shares) internal {
        require(recipient != address(0), "INVALID_RECIPIENT");
        require(balanceOf[owner] >= shares, "INSUFFICIENT_SHARES");
        balanceOf[owner] -= shares;
        balanceOf[recipient] += shares;
    }
}
