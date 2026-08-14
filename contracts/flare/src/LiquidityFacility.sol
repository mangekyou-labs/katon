// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Facility {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IFacilityAdapter {
    function asset() external view returns (address);
    function deposit(uint256 assets) external returns (uint256 deployed);
    function withdraw(uint256 assets, address receiver) external returns (uint256 returned);
    function totalAssets() external view returns (uint256);
    function maxWithdraw() external view returns (uint256);
}

interface IEligibilityRegistryFacility {
    function requireEligible(
        bytes32 policyId,
        address wallet,
        uint256 role,
        bytes32 issuerReference,
        uint256 expectedRevocationEpoch
    ) external view;
}

interface INavProofRegistryFacility {
    function latest(address asset)
        external
        view
        returns (uint256 value, uint8 decimals, uint64 asOf, uint64 validUntil);

    function redemptionReceipt(bytes32 requestId) external view returns (uint256 receivedAssets, uint64 validUntil);
}

contract LiquidityFacility {
    struct WithdrawalRequest {
        address owner;
        address receiver;
        uint256 shares;
        uint256 minAssets;
        bool settled;
        bool cancelled;
    }

    struct RedemptionRequest {
        uint256 expectedAssets;
        bool settled;
    }

    struct AdapterState {
        bool allowed;
        uint256 deployed;
    }

    struct InventoryLot {
        address rwa;
        uint256 inventoryAmount;
        uint256 acquisitionCost;
        uint256 verifiedNav;
    }

    address public immutable asset;
    address public immutable owner;
    address public guardian;
    address public router;
    address public eligibilityRegistry;
    address public navProofRegistry;
    bool public paused;

    uint256 public totalShares;
    uint256 public idleAssets;
    uint256 public deployedAssets;
    uint256 public inventoryNav;
    uint256 public receivables;
    uint256 public realizedLoss;
    uint256 public maxTotalAssets;
    uint256 public maxTotalDeployed;
    uint256 public maxAdapterAllocation;
    uint256 public maxQuoteDecisionBlockAge = 256;
    uint256 public nextWithdrawalToSettle = 1;

    mapping(address owner => uint256 shares) public shareBalance;
    mapping(address rwa => bool approved) public approvedRwa;
    mapping(address rwa => uint256 navPerUnit) public rwaNav;
    mapping(address rwa => uint256 haircutBps) public rwaHaircutBps;
    mapping(address rwa => uint256 inventoryAmount) public inventoryByRwa;
    mapping(address rwa => uint256 cap) public inventoryCap;
    mapping(address adapter => AdapterState state) public adapters;
    mapping(uint256 requestId => WithdrawalRequest request) public withdrawals;
    mapping(bytes32 requestId => RedemptionRequest request) public redemptions;
    uint256 public nextWithdrawalId = 1;
    uint256 private reentrancyLock = 1;
    // Append-only upgrade storage: keep new lot state after the original layout.
    mapping(uint256 lotId => InventoryLot lot) public inventoryLots;
    uint256 public nextInventoryLotId = 1;
    address[] private adapterOrder;
    mapping(address adapter => bool seen) private adapterSeen;

    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event WithdrawalRequested(uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares, uint256 minAssets);
    event WithdrawalSettled(uint256 indexed requestId, address indexed receiver, uint256 assets);
    event WithdrawalCancelled(uint256 indexed requestId, address indexed owner, uint256 shares);
    event AdapterConfigured(address indexed adapter, bool allowed);
    event QuotePolicyConfigured(uint256 maxDecisionBlockAge);
    event RwaConfigured(address indexed rwa, uint256 navPerUnit, bool approved);
    event InventoryBooked(address indexed rwa, uint256 nav);
    event InventoryLotBooked(uint256 indexed lotId, address indexed rwa, uint256 inventoryAmount, uint256 acquisitionCost, uint256 verifiedNav);
    event InventoryLotNavUpdated(uint256 indexed lotId, uint256 verifiedNav, uint256 carryingValue);
    event RedemptionBooked(bytes32 indexed requestId, uint256 expectedAssets);
    event RedemptionSettled(bytes32 indexed requestId, uint256 receivedAssets, uint256 realizedLoss);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier nonReentrant() {
        require(reentrancyLock == 1, "REENTRANT");
        reentrancyLock = 2;
        _;
        reentrancyLock = 1;
    }

    constructor(address asset_) {
        require(asset_ != address(0), "ASSET_REQUIRED");
        asset = asset_;
        owner = msg.sender;
    }

    function totalAssets() public view returns (uint256) {
        return idleAssets + _adapterNav() + inventoryNav + receivables;
    }

    function balanceOf(address owner_) external view returns (uint256) {
        return shareBalance[owner_];
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 assetsBefore = totalAssets();
        return totalShares == 0 || assetsBefore == 0 ? assets : (assets * totalShares) / assetsBefore;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalShares == 0 ? 0 : (shares * totalAssets()) / totalShares;
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        uint256 assetsBefore = totalAssets();
        if (shares == 0 || totalShares == 0 || assetsBefore == 0) return shares;
        return (shares * assetsBefore + totalShares - 1) / totalShares;
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 assetsBefore = totalAssets();
        require(totalShares > 0 && assetsBefore > 0, "WITHDRAWAL_NAV");
        return (assets * totalShares + assetsBefore - 1) / assetsBefore;
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    function maxDeposit(address receiver) external view returns (uint256) {
        if (paused || receiver == address(0)) return 0;
        return _maxDeposit();
    }

    function maxMint(address receiver) external view returns (uint256) {
        if (paused || receiver == address(0)) return 0;
        uint256 assets = _maxDeposit();
        return assets == type(uint256).max ? type(uint256).max : previewDeposit(assets);
    }

    function maxWithdraw(address owner_) external view returns (uint256) {
        if (paused || owner_ == address(0)) return 0;
        uint256 byShares = convertToAssets(shareBalance[owner_]);
        return idleAssets < byShares ? idleAssets : byShares;
    }

    function maxRedeem(address owner_) external view returns (uint256) {
        if (paused || owner_ == address(0) || totalShares == 0 || totalAssets() == 0) return 0;
        uint256 liquidShares = (idleAssets * totalShares) / totalAssets();
        uint256 balance = shareBalance[owner_];
        return balance < liquidShares ? balance : liquidShares;
    }

    function _maxDeposit() private view returns (uint256) {
        if (maxTotalAssets == 0) return type(uint256).max;
        uint256 assetsBefore = totalAssets();
        return assetsBefore >= maxTotalAssets ? 0 : maxTotalAssets - assetsBefore;
    }

    function setRouter(address router_) external onlyOwner {
        require(router_ != address(0), "ROUTER_REQUIRED");
        router = router_;
    }

    function setEligibilityRegistry(address registry) external onlyOwner {
        require(registry != address(0), "REGISTRY_REQUIRED");
        eligibilityRegistry = registry;
    }

    function setNavProofRegistry(address registry) external onlyOwner {
        require(registry != address(0), "NAV_REGISTRY_REQUIRED");
        navProofRegistry = registry;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
    }

    function guardianPause() external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        paused = true;
    }

    function setRiskCaps(uint256 totalAssetsCap, uint256 totalDeployedCap, uint256 adapterCap) external onlyOwner {
        maxTotalAssets = totalAssetsCap;
        maxTotalDeployed = totalDeployedCap;
        maxAdapterAllocation = adapterCap;
    }

    function setQuotePolicy(uint256 maxDecisionBlockAge) external onlyOwner {
        require(maxDecisionBlockAge <= 256, "QUOTE_SNAPSHOT_AGE");
        maxQuoteDecisionBlockAge = maxDecisionBlockAge;
        emit QuotePolicyConfigured(maxDecisionBlockAge);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        require(adapter != address(0), "ADAPTER_REQUIRED");
        require(IFacilityAdapter(adapter).asset() == asset, "ADAPTER_ASSET");
        adapters[adapter].allowed = allowed;
        if (!adapterSeen[adapter]) {
            adapterSeen[adapter] = true;
            adapterOrder.push(adapter);
        }
        emit AdapterConfigured(adapter, allowed);
    }

    function setRwa(address rwa, uint256 navPerUnit, bool approved) external onlyOwner {
        _setRwa(rwa, navPerUnit, rwaHaircutBps[rwa], 0, approved);
    }

    function setRwaPolicy(address rwa, uint256 navPerUnit, uint256 haircutBps, uint256 inventoryCap_, bool approved)
        external
        onlyOwner
    {
        _setRwa(rwa, navPerUnit, haircutBps, inventoryCap_, approved);
    }

    function _setRwa(address rwa, uint256 navPerUnit, uint256 haircutBps, uint256 inventoryCap_, bool approved)
        private
    {
        require(rwa != address(0), "RWA_REQUIRED");
        require(!approved || navPerUnit > 0, "NAV_REQUIRED");
        require(haircutBps <= 10_000, "HAIRCUT_POLICY");
        approvedRwa[rwa] = approved;
        rwaNav[rwa] = navPerUnit;
        rwaHaircutBps[rwa] = haircutBps;
        if (inventoryCap_ > 0) require(inventoryByRwa[rwa] <= inventoryCap_, "INVENTORY_CAP");
        inventoryCap[rwa] = inventoryCap_;
        emit RwaConfigured(rwa, navPerUnit, approved);
    }

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        require(!paused, "FACILITY_PAUSED");
        require(receiver != address(0) && assets > 0, "DEPOSIT_INVALID");
        if (maxTotalAssets > 0) require(totalAssets() + assets <= maxTotalAssets, "FACILITY_CAP");
        uint256 assetsBefore = totalAssets();
        require(totalShares == 0 || assetsBefore > 0, "DEPOSIT_NAV");
        shares = totalShares == 0 ? assets : (assets * totalShares) / assetsBefore;
        require(shares > 0, "DEPOSIT_ROUNDING");
        _safeTransferFrom(asset, msg.sender, address(this), assets);
        idleAssets += assets;
        shareBalance[receiver] += shares;
        totalShares += shares;
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        external
        nonReentrant
        returns (uint256 shares)
    {
        require(!paused, "FACILITY_PAUSED");
        require(msg.sender == owner_, "WITHDRAW_AUTH");
        require(receiver != address(0) && assets > 0, "WITHDRAWAL_ASSETS");
        uint256 assetsBefore = totalAssets();
        require(totalShares > 0 && assetsBefore > 0, "WITHDRAWAL_NAV");
        shares = (assets * totalShares + assetsBefore - 1) / assetsBefore;
        require(shares <= shareBalance[owner_], "WITHDRAWAL_SHARES");
        require(idleAssets >= assets, "WITHDRAWAL_LIQUIDITY");
        shareBalance[owner_] -= shares;
        totalShares -= shares;
        idleAssets -= assets;
        _safeTransfer(asset, receiver, assets);
        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        external
        nonReentrant
        returns (uint256 assets)
    {
        require(!paused, "FACILITY_PAUSED");
        require(msg.sender == owner_, "WITHDRAW_AUTH");
        require(receiver != address(0) && shares > 0 && shares <= shareBalance[owner_], "WITHDRAWAL_SHARES");
        assets = convertToAssets(shares);
        require(assets > 0, "WITHDRAWAL_ROUNDING");
        require(idleAssets >= assets, "WITHDRAWAL_LIQUIDITY");
        shareBalance[owner_] -= shares;
        totalShares -= shares;
        idleAssets -= assets;
        _safeTransfer(asset, receiver, assets);
        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    function requestWithdraw(uint256 shares, address receiver, address owner_, uint256 minAssets)
        external
        returns (uint256 requestId)
    {
        require(!paused, "FACILITY_PAUSED");
        require(msg.sender == owner_, "WITHDRAW_AUTH");
        require(receiver != address(0) && shares > 0 && shares <= shareBalance[owner_], "WITHDRAWAL_SHARES");
        uint256 assets = (shares * totalAssets()) / totalShares;
        require(assets > 0, "WITHDRAWAL_ROUNDING");
        require(assets >= minAssets, "WITHDRAWAL_MIN_ASSETS");
        shareBalance[owner_] -= shares;
        requestId = nextWithdrawalId++;
        withdrawals[requestId] = WithdrawalRequest(owner_, receiver, shares, minAssets, false, false);
        emit WithdrawalRequested(requestId, owner_, receiver, shares, minAssets);
    }

    function cancelWithdraw(uint256 requestId) external nonReentrant {
        WithdrawalRequest storage request = withdrawals[requestId];
        require(request.owner != address(0), "WITHDRAWAL_UNKNOWN");
        require(msg.sender == request.owner, "WITHDRAW_AUTH");
        require(!request.settled && !request.cancelled, "WITHDRAWAL_CANCELLED");
        request.cancelled = true;
        shareBalance[request.owner] += request.shares;
        emit WithdrawalCancelled(requestId, request.owner, request.shares);
    }

    function settleWithdraw(uint256 requestId) external nonReentrant {
        WithdrawalRequest storage request = withdrawals[requestId];
        require(request.owner != address(0), "WITHDRAWAL_UNKNOWN");
        require(!request.settled, "WITHDRAWAL_SETTLED");
        require(!request.cancelled, "WITHDRAWAL_CANCELLED");
        while (withdrawals[nextWithdrawalToSettle].cancelled) {
            nextWithdrawalToSettle += 1;
        }
        require(requestId == nextWithdrawalToSettle, "WITHDRAWAL_ORDER");
        uint256 assets = (request.shares * totalAssets()) / totalShares;
        require(assets >= request.minAssets, "WITHDRAWAL_MIN_ASSETS");
        require(idleAssets >= assets, "WITHDRAWAL_LIQUIDITY");
        request.settled = true;
        idleAssets -= assets;
        totalShares -= request.shares;
        nextWithdrawalToSettle += 1;
        _safeTransfer(asset, request.receiver, assets);
        emit WithdrawalSettled(requestId, request.receiver, assets);
    }

    function allocate(address adapter, uint256 assets) external onlyOwner nonReentrant {
        require(!paused, "FACILITY_PAUSED");
        AdapterState storage state = adapters[adapter];
        require(state.allowed, "ADAPTER_NOT_ALLOWED");
        require(assets > 0 && assets <= idleAssets, "ALLOCATE_AMOUNT");
        if (maxTotalDeployed > 0) require(deployedAssets + assets <= maxTotalDeployed, "DEPLOYED_CAP");
        if (maxAdapterAllocation > 0) require(state.deployed + assets <= maxAdapterAllocation, "ADAPTER_CAP");
        _safeTransfer(asset, adapter, assets);
        IFacilityAdapter(adapter).deposit(assets);
        state.deployed += assets;
        idleAssets -= assets;
        deployedAssets += assets;
    }

    function deallocate(address adapter, uint256 assets) external onlyOwner nonReentrant {
        AdapterState storage state = adapters[adapter];
        require(state.allowed, "ADAPTER_NOT_ALLOWED");
        require(assets > 0 && assets <= state.deployed, "DEALLOCATE_AMOUNT");
        uint256 beforeBalance = IERC20Facility(asset).balanceOf(address(this));
        IFacilityAdapter(adapter).withdraw(assets, address(this));
        uint256 returned = IERC20Facility(asset).balanceOf(address(this)) - beforeBalance;
        state.deployed -= assets;
        deployedAssets -= assets;
        idleAssets += returned;
        if (returned < assets) realizedLoss += assets - returned;
    }

    function quote(address rwa, uint256 amount, uint256 decisionBlock) external view returns (uint256 output) {
        require(!paused && approvedRwa[rwa] && amount > 0, "QUOTE_UNAVAILABLE");
        require(decisionBlock <= block.number, "QUOTE_SNAPSHOT_FUTURE");
        require(block.number - decisionBlock <= maxQuoteDecisionBlockAge, "QUOTE_SNAPSHOT_STALE");
        if (inventoryCap[rwa] > 0) require(inventoryByRwa[rwa] + amount <= inventoryCap[rwa], "QUOTE_CAP");
        output = _quoteOutput(rwa, amount);
        require(output <= _liquidAssets(), "QUOTE_LIQUIDITY");
    }

    function execute(
        address seller,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minOutput,
        bytes calldata sourceData
    ) external nonReentrant returns (uint256 output) {
        require(!paused && msg.sender == router, "EXECUTE_AUTH");
        require(seller != address(0) && buyToken == asset, "EXECUTE_ASSET");
        require(approvedRwa[sellToken] && sellAmount > 0, "EXECUTE_RWA");
        if (eligibilityRegistry != address(0)) {
            require(sourceData.length > 0, "ELIGIBILITY_REQUIRED");
            (bytes32 policyId, uint256 revocationEpoch, uint256 role, bytes32 issuerReference) = abi.decode(
                sourceData, (bytes32, uint256, uint256, bytes32)
            );
            IEligibilityRegistryFacility(eligibilityRegistry).requireEligible(
                policyId, seller, role, issuerReference, revocationEpoch
            );
        }
        if (inventoryCap[sellToken] > 0) {
            require(inventoryByRwa[sellToken] + sellAmount <= inventoryCap[sellToken], "EXECUTE_CAP");
        }
        output = _quoteOutput(sellToken, sellAmount);
        require(output >= minOutput, "EXECUTE_OUTPUT");
        _ensureIdle(output);
        require(output <= idleAssets, "EXECUTE_OUTPUT");
        _safeTransferFrom(sellToken, seller, address(this), sellAmount);
        idleAssets -= output;
        inventoryNav += output;
        inventoryByRwa[sellToken] += sellAmount;
        uint256 lotId = nextInventoryLotId == 0 ? 1 : nextInventoryLotId;
        nextInventoryLotId = lotId + 1;
        uint256 verifiedNav = (sellAmount * _navPerUnit(sellToken)) / 1e18;
        inventoryLots[lotId] = InventoryLot(sellToken, sellAmount, output, verifiedNav);
        emit InventoryLotBooked(lotId, sellToken, sellAmount, output, verifiedNav);
        _safeTransfer(asset, msg.sender, output);
    }

    /// @notice Owner mark-to-market only when a proof registry is not configured.
    function updateInventoryLotNav(uint256 lotId, uint256 verifiedNav) external onlyOwner {
        require(navProofRegistry == address(0), "NAV_REGISTRY_MODE");
        _applyInventoryLotNav(lotId, verifiedNav);
    }

    /// @notice Refresh lot NAV from the verified NavProofRegistry.latest record.
    function refreshInventoryLotNav(uint256 lotId) external nonReentrant {
        require(navProofRegistry != address(0), "NAV_REGISTRY_REQUIRED");
        InventoryLot storage lot = inventoryLots[lotId];
        require(lot.rwa != address(0), "INVENTORY_LOT");
        uint256 verifiedNav = (lot.inventoryAmount * _navPerUnit(lot.rwa)) / 1e18;
        _applyInventoryLotNav(lotId, verifiedNav);
    }

    function _applyInventoryLotNav(uint256 lotId, uint256 verifiedNav) private {
        InventoryLot storage lot = inventoryLots[lotId];
        require(lot.rwa != address(0) && verifiedNav > 0, "INVENTORY_LOT");
        uint256 previousCarrying = lot.acquisitionCost < lot.verifiedNav ? lot.acquisitionCost : lot.verifiedNav;
        lot.verifiedNav = verifiedNav;
        uint256 carrying = lot.acquisitionCost < verifiedNav ? lot.acquisitionCost : verifiedNav;
        if (carrying >= previousCarrying) inventoryNav += carrying - previousCarrying;
        else inventoryNav -= previousCarrying - carrying;
        emit InventoryLotNavUpdated(lotId, verifiedNav, carrying);
    }

    function bookRedemptionFromLot(bytes32 requestId, uint256 lotId, uint256 expectedAssets)
        external
        onlyOwner
    {
        require(requestId != bytes32(0) && !redemptions[requestId].settled && redemptions[requestId].expectedAssets == 0, "REDEMPTION_REPLAY");
        InventoryLot memory lot = inventoryLots[lotId];
        require(lot.rwa != address(0) && expectedAssets > 0, "REDEMPTION_LOT");
        uint256 carrying = lot.acquisitionCost < lot.verifiedNav ? lot.acquisitionCost : lot.verifiedNav;
        delete inventoryLots[lotId];
        inventoryNav -= carrying;
        inventoryByRwa[lot.rwa] -= lot.inventoryAmount;
        receivables += expectedAssets;
        redemptions[requestId] = RedemptionRequest(expectedAssets, false);
        emit RedemptionBooked(requestId, expectedAssets);
    }

    function fund(address recipient, address debtToken, uint256 amount)
        external
        nonReentrant
        returns (uint256)
    {
        return _fundFromIdle(recipient, debtToken, amount);
    }

    function fundLiquidation(address recipient, address debtToken, uint256 amount)
        external
        nonReentrant
        returns (uint256)
    {
        return _fundFromIdle(recipient, debtToken, amount);
    }

    function settleRedemption(bytes32 requestId, uint256 receivedAssets) external nonReentrant {
        RedemptionRequest storage request = redemptions[requestId];
        require(request.expectedAssets > 0 && !request.settled, "REDEMPTION_SETTLED");
        require(receivedAssets <= request.expectedAssets, "REDEMPTION_RECEIPT");
        if (navProofRegistry != address(0)) {
            (uint256 proven, uint64 validUntil) =
                INavProofRegistryFacility(navProofRegistry).redemptionReceipt(requestId);
            require(proven == receivedAssets && validUntil >= block.timestamp, "REDEMPTION_PROOF");
        } else {
            require(msg.sender == owner, "ONLY_OWNER");
        }
        request.settled = true;
        receivables -= request.expectedAssets;
        idleAssets += receivedAssets;
        uint256 loss = request.expectedAssets - receivedAssets;
        realizedLoss += loss;
        _safeTransferFrom(asset, msg.sender, address(this), receivedAssets);
        emit RedemptionSettled(requestId, receivedAssets, loss);
    }

    function _quoteOutput(address rwa, uint256 amount) private view returns (uint256 output) {
        uint256 gross = (amount * _navPerUnit(rwa)) / 1e18;
        output = (gross * (10_000 - rwaHaircutBps[rwa])) / 10_000;
    }

    /// @dev Prefer verified NavProofRegistry.latest when configured; otherwise the owner-set rwaNav.
    function _navPerUnit(address rwa) private view returns (uint256 navPerUnit) {
        if (navProofRegistry != address(0)) {
            (uint256 value, uint8 decimals,, uint64 validUntil) =
                INavProofRegistryFacility(navProofRegistry).latest(rwa);
            require(value > 0 && validUntil >= block.timestamp, "NAV_INVALID");
            if (decimals == 18) return value;
            if (decimals < 18) return value * (10 ** (18 - decimals));
            return value / (10 ** (decimals - 18));
        }
        navPerUnit = rwaNav[rwa];
        require(navPerUnit > 0, "NAV_REQUIRED");
    }

    function _adapterNav() private view returns (uint256 nav) {
        for (uint256 i = 0; i < adapterOrder.length; i++) {
            address adapter = adapterOrder[i];
            if (!adapters[adapter].allowed) continue;
            nav += IFacilityAdapter(adapter).totalAssets();
        }
    }

    function _liquidAssets() private view returns (uint256 liquid) {
        liquid = idleAssets;
        for (uint256 i = 0; i < adapterOrder.length; i++) {
            address adapter = adapterOrder[i];
            if (!adapters[adapter].allowed) continue;
            liquid += IFacilityAdapter(adapter).maxWithdraw();
        }
    }

    function _fundFromIdle(address recipient, address debtToken, uint256 amount) private returns (uint256) {
        require(!paused && msg.sender == router, "FUND_AUTH");
        require(recipient != address(0) && debtToken == asset && amount > 0, "FUND_ASSET");
        _ensureIdle(amount);
        idleAssets -= amount;
        _safeTransfer(asset, recipient, amount);
        return amount;
    }

    function _ensureIdle(uint256 needed) private {
        if (idleAssets >= needed) return;
        uint256 remaining = needed - idleAssets;
        for (uint256 i = 0; i < adapterOrder.length && remaining > 0; i++) {
            address adapter = adapterOrder[i];
            if (!adapters[adapter].allowed) continue;
            uint256 available = IFacilityAdapter(adapter).maxWithdraw();
            if (available == 0) continue;
            uint256 pull = remaining < available ? remaining : available;
            uint256 returned = _pullFromAdapter(adapter, pull);
            remaining = returned >= remaining ? 0 : remaining - returned;
        }
    }

    function _pullFromAdapter(address adapter, uint256 assets) private returns (uint256 returned) {
        AdapterState storage state = adapters[adapter];
        uint256 beforeBalance = IERC20Facility(asset).balanceOf(address(this));
        IFacilityAdapter(adapter).withdraw(assets, address(this));
        returned = IERC20Facility(asset).balanceOf(address(this)) - beforeBalance;
        idleAssets += returned;
        uint256 principalReduction = returned < state.deployed ? returned : state.deployed;
        state.deployed -= principalReduction;
        deployedAssets -= principalReduction;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20Facility.transfer.selector, to, amount)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "TOKEN_TRANSFER_FAILED");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20Facility.transferFrom.selector, from, to, amount)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "TOKEN_TRANSFER_FROM_FAILED");
    }
}
