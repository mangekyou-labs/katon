// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "../IERC20.sol";
import { IMorphoBlue } from "../adapters/MorphoYieldAdapter.sol";

contract BaseQaERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    bool public initialized;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function initialize(string calldata name_, string calldata symbol_, uint8 decimals_)
        public
        virtual
    {
        require(!initialized, "ALREADY_INITIALIZED");
        initialized = true;
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address account, uint256 amount) external virtual {
        require(initialized && account != address(0), "INVALID_MINT");
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external virtual returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external virtual returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount)
        external
        virtual
        returns (bool)
    {
        if (msg.sender != owner) {
            uint256 approved = allowance[owner][msg.sender];
            require(approved >= amount, "INSUFFICIENT_ALLOWANCE");
            allowance[owner][msg.sender] = approved - amount;
        }
        _transfer(owner, recipient, amount);
        return true;
    }

    function _transfer(address owner, address recipient, uint256 amount) internal {
        require(recipient != address(0), "INVALID_RECIPIENT");
        uint256 balance = balanceOf[owner];
        require(balance >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[owner] = balance - amount;
        balanceOf[recipient] += amount;
    }
}

contract BaseQaB20 is BaseQaERC20 {
    bytes32 public constant TRANSFER_SENDER_POLICY = keccak256("TRANSFER_SENDER");
    bytes32 public constant TRANSFER_RECEIVER_POLICY = keccak256("TRANSFER_RECEIVER");
    uint256 public constant WAD_PRECISION = 1e18;

    function multiplier() external pure returns (uint256) { return WAD_PRECISION; }
    function scaledBalanceOf(address account) external view returns (uint256) {
        return balanceOf[account];
    }
    function pausedFeatures() external pure returns (uint8[] memory values) { return values; }
    function policyId(bytes32 scope) external pure returns (uint64) {
        if (scope == TRANSFER_SENDER_POLICY) return 1;
        if (scope == TRANSFER_RECEIVER_POLICY) return 2;
        revert("UNKNOWN_SCOPE");
    }
}

contract BaseQaPolicyRegistry {
    function getOracleParams(address) external pure returns (uint256, bool) { return (1e18, false); }
    function isAuthorized(uint64, address) external pure returns (bool) { return true; }
}

contract BaseQaOracleFeed {
    uint8 public immutable decimals;
    bool public immutable sequencer;

    constructor(bool sequencer_) {
        sequencer = sequencer_;
        decimals = 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 observedAt = block.timestamp - 1;
        uint256 startedAt = sequencer ? block.timestamp - 7_201 : observedAt;
        int256 answer = sequencer ? int256(0) : int256(100_000_000);
        return (1, answer, startedAt, observedAt, 1);
    }
}

/// @dev Mutable oracle used only by a fork-created Morpho market.  It has the
/// same single-method surface as Morpho Blue's oracle interface while keeping
/// the price control local to the fork process.
contract BaseQaMutableOracle {
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 public constant MORPHO_PRICE_SCALE = 1e24;
    uint256 public constant EULER_PRICE_SCALE = 1e36;

    uint256 public price;

    constructor(uint256 initialPrice) {
        price = initialPrice;
    }

    function setPrice(uint256 nextPrice) external {
        require(nextPrice != 0, "INVALID_PRICE");
        price = nextPrice;
    }

    /// @dev Implements Euler's canonical IPriceOracle surface as well as the
    /// Morpho Blue getPrice surface.  The stored value is Morpho's 1e24
    /// price scale for an 18-decimal B20 against 6-decimal USDC.
    function name() external pure returns (string memory) {
        return "Katon Fork QA Oracle";
    }

    function getQuote(uint256 inAmount, address base, address quote)
        public
        view
        returns (uint256)
    {
        if (base == quote) return inAmount;
        // Morpho consumes price() at 1e24. Euler's IPriceOracle quote is an
        // asset-unit conversion, so the 18-decimal B20/6-decimal USDC pair
        // uses 1e36 as the denominator (18 + 18), preserving both units.
        if (quote == USDC) return inAmount * price / EULER_PRICE_SCALE;
        if (base == USDC) return inAmount * EULER_PRICE_SCALE / price;
        revert("UNSUPPORTED_PAIR");
    }

    function getQuotes(uint256 inAmount, address base, address quote)
        external
        view
        returns (uint256 bid, uint256 ask)
    {
        bid = getQuote(inAmount, base, quote);
        ask = bid;
    }
}

contract BaseQaAavePool {
    address public immutable debtAsset;
    address public immutable collateralAsset;
    uint256 public immutable seizeRateWad;
    uint256 public liquidationDebtLimit;

    constructor(address debtAsset_, address collateralAsset_, uint256 seizeRateWad_) {
        debtAsset = debtAsset_;
        collateralAsset = collateralAsset_;
        seizeRateWad = seizeRateWad_;
    }

    function setLiquidationDebtLimit(uint256 value) external {
        liquidationDebtLimit = value;
    }

    function liquidationCall(
        address collateralAsset_,
        address debtAsset_,
        address,
        uint256 debtToCover,
        bool receiveAToken
    ) external {
        require(!receiveAToken, "ATOKEN_UNSUPPORTED");
        require(debtAsset_ == debtAsset && collateralAsset_ == collateralAsset, "WRONG_ASSET");
        uint256 consumed = liquidationDebtLimit != 0 && liquidationDebtLimit < debtToCover
            ? liquidationDebtLimit
            : debtToCover;
        require(
            BaseQaERC20(debtAsset).transferFrom(msg.sender, address(this), consumed),
            "ASSET_TRANSFER_FAILED"
        );
        uint256 collateralOut = consumed * 1e12 * seizeRateWad / 1e18;
        BaseQaERC20(collateralAsset).mint(msg.sender, collateralOut);
    }
}

/// @dev A deterministic control market used only inside the local Base fork.
/// Its ABI is the Morpho Blue ABI so adapter and accounting tests exercise the
/// same selectors while the official Morpho singleton remains a separate,
/// read-only fork evidence target.
contract BaseQaMorphoBlue is IMorphoBlue {
    address public immutable asset;
    bool public reverting;
    uint256 public liquidationRepayLimit;
    mapping(bytes32 => Market) internal markets;
    mapping(bytes32 => mapping(address => Position)) internal positions;

    constructor(address asset_) {
        asset = asset_;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function setLiquidationRepayLimit(uint256 value) external {
        liquidationRepayLimit = value;
    }

    function setMarketTotals(
        MarketParams calldata params,
        uint128 totalSupplyAssets,
        uint128 totalSupplyShares,
        uint128 totalBorrowAssets,
        uint128 totalBorrowShares
    ) external {
        bytes32 id = keccak256(abi.encode(params));
        markets[id] = Market({
            totalSupplyAssets: totalSupplyAssets,
            totalSupplyShares: totalSupplyShares,
            totalBorrowAssets: totalBorrowAssets,
            totalBorrowShares: totalBorrowShares,
            lastUpdate: uint128(block.timestamp),
            fee: 0
        });
    }

    function accrueInterest(MarketParams calldata) external view {
        require(!reverting, "VENUE_REVERT");
    }

    function supply(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        bytes calldata data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied) {
        require(!reverting, "VENUE_REVERT");
        require(data.length == 0 && params.loanToken == asset, "WRONG_MARKET");
        bytes32 id = keccak256(abi.encode(params));
        Market storage current = markets[id];
        sharesSupplied = shares;
        if (sharesSupplied == 0) {
            sharesSupplied = current.totalSupplyShares == 0
                ? assets
                : assets * current.totalSupplyShares / current.totalSupplyAssets;
        }
        require(IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED");
        current.totalSupplyAssets += uint128(assets);
        current.totalSupplyShares += uint128(sharesSupplied);
        positions[id][onBehalfOf].supplyShares += sharesSupplied;
        return (assets, sharesSupplied);
    }

    function withdraw(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn) {
        require(!reverting, "VENUE_REVERT");
        bytes32 id = keccak256(abi.encode(params));
        Market storage current = markets[id];
        Position storage position_ = positions[id][onBehalfOf];
        sharesWithdrawn = shares;
        if (sharesWithdrawn == 0) {
            sharesWithdrawn = assets * current.totalSupplyShares / current.totalSupplyAssets;
        }
        require(position_.supplyShares >= sharesWithdrawn, "INSUFFICIENT_SHARES");
        assetsWithdrawn = assets == 0
            ? sharesWithdrawn * current.totalSupplyAssets / current.totalSupplyShares
            : assets;
        position_.supplyShares -= sharesWithdrawn;
        current.totalSupplyShares -= uint128(sharesWithdrawn);
        current.totalSupplyAssets -= uint128(assetsWithdrawn);
        require(IERC20(asset).transfer(receiver, assetsWithdrawn), "ASSET_TRANSFER_FAILED");
        return (assetsWithdrawn, sharesWithdrawn);
    }

    function liquidate(
        MarketParams calldata params,
        address,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 seizedAssetsOut, uint256 repaidAssets) {
        require(!reverting, "VENUE_REVERT");
        require(params.loanToken == asset && seizedAssets == 0 && data.length == 0, "WRONG_MARKET");
        bytes32 id = keccak256(abi.encode(params));
        Market memory current = markets[id];
        repaidAssets = current.totalBorrowAssets == 0 || current.totalBorrowShares == 0
            ? repaidShares
            : repaidShares * current.totalBorrowAssets / current.totalBorrowShares;
        if (liquidationRepayLimit != 0 && liquidationRepayLimit < repaidAssets) {
            repaidAssets = liquidationRepayLimit;
        }
        seizedAssetsOut = repaidAssets * 110 / 100;
        require(IERC20(asset).transferFrom(msg.sender, address(this), repaidAssets), "ASSET_TRANSFER_FAILED");
        require(IERC20(params.collateralToken).transfer(msg.sender, seizedAssetsOut), "COLLATERAL_TRANSFER_FAILED");
    }

    function position(bytes32 id, address user) external view returns (Position memory) {
        return positions[id][user];
    }

    function market(bytes32 id) external view returns (Market memory) {
        return markets[id];
    }
}

/// @dev Euler selector-faithful control vault for fork-created collateral and
/// debt scenarios. It is explicitly classified as QA control state in the
/// deployment manifest and is never treated as a live Euler deployment.
contract BaseQaEulerVault {
    address public immutable asset;
    bool public reverting;
    address public collateralVault;
    uint256 public totalSupply;
    uint256 public storedTotalAssets;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public inheritedDebt;
    mapping(address => uint256) public liquidationShares;
    uint256 public liquidationRepayLimit;
    uint256 public liquidationYieldLimit;

    constructor(address asset_) {
        asset = asset_;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function setCollateralVault(address vault) external {
        collateralVault = vault;
    }

    function setLiquidationLimits(uint256 maxRepay, uint256 maxYield) external {
        liquidationRepayLimit = maxRepay;
        liquidationYieldLimit = maxYield;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(!reverting, "VENUE_REVERT");
        require(IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED");
        shares = totalSupply == 0 || storedTotalAssets == 0
            ? assets
            : assets * totalSupply / storedTotalAssets;
        totalSupply += shares;
        balanceOf[receiver] += shares;
        storedTotalAssets += assets;
    }

    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares)
    {
        require(!reverting, "VENUE_REVERT");
        shares = previewWithdraw(assets);
        require(balanceOf[owner] >= shares, "INSUFFICIENT_SHARES");
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        storedTotalAssets -= assets;
        require(IERC20(asset).transfer(receiver, assets), "ASSET_TRANSFER_FAILED");
    }

    function previewWithdraw(uint256 assets) public view returns (uint256 shares) {
        if (totalSupply == 0 || storedTotalAssets == 0) return assets;
        return (assets * totalSupply + storedTotalAssets - 1) / storedTotalAssets;
    }

    function checkLiquidation(address, address, address collateral)
        external
        view
        returns (uint256 maxRepay, uint256 maxYield)
    {
        require(collateral == collateralVault, "WRONG_COLLATERAL_VAULT");
        maxRepay = liquidationRepayLimit == 0 ? type(uint256).max : liquidationRepayLimit;
        maxYield = liquidationYieldLimit == 0 ? type(uint256).max : liquidationYieldLimit;
    }

    function liquidate(address, address collateral, uint256 repayAssets, uint256 minYieldBalance)
        external
    {
        require(!reverting && collateral == collateralVault, "WRONG_COLLATERAL_VAULT");
        uint256 seizedShares = repayAssets * 110 / 100;
        require(seizedShares >= minYieldBalance, "HEALTHY");
        inheritedDebt[msg.sender] += repayAssets;
        BaseQaEulerVault(collateralVault).mintLiquidationShares(msg.sender, seizedShares);
    }

    function repay(uint256 assets, address account) external returns (uint256 shares) {
        require(!reverting && inheritedDebt[account] >= assets, "INSUFFICIENT_DEBT");
        require(IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED");
        inheritedDebt[account] -= assets;
        return assets;
    }

    function mintLiquidationShares(address account, uint256 shares) external {
        balanceOf[account] += shares;
        liquidationShares[account] += shares;
        totalSupply += shares;
        BaseQaERC20(asset).mint(address(this), shares);
    }

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        require(!reverting && balanceOf[owner] >= shares, "INSUFFICIENT_SHARES");
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        if (liquidationShares[owner] >= shares) {
            liquidationShares[owner] -= shares;
            assets = shares;
        } else {
            assets = shares * storedTotalAssets / totalSupply;
            storedTotalAssets -= assets;
        }
        require(IERC20(asset).transfer(receiver, assets), "ASSET_TRANSFER_FAILED");
    }

    function totalAssets() external view returns (uint256) {
        return storedTotalAssets;
    }

    function maxWithdraw(address owner) external view returns (uint256 assets) {
        if (totalSupply == 0) return 0;
        return balanceOf[owner] * storedTotalAssets / totalSupply;
    }
}

/// @dev Minimal controlled Aerodrome-style quote book. No swap entry point is
/// exposed; the router can only read the reserves and constant-product quote.
contract BaseQaAerodromePool {
    address public immutable token0;
    address public immutable token1;
    uint256 public reserve0;
    uint256 public reserve1;

    constructor(address token0_, address token1_, uint256 reserve0_, uint256 reserve1_) {
        token0 = token0_;
        token1 = token1_;
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, block.timestamp);
    }

    function getAmountOut(uint256 amountIn, address tokenIn)
        external
        view
        returns (uint256 amountOut)
    {
        require(tokenIn == token0 || tokenIn == token1, "WRONG_TOKEN");
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0
            ? (reserve0, reserve1)
            : (reserve1, reserve0);
        require(amountIn != 0 && reserveIn != 0 && reserveOut != 0, "NO_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 997;
        amountOut = amountInWithFee * reserveOut / (reserveIn * 1000 + amountInWithFee);
    }
}
