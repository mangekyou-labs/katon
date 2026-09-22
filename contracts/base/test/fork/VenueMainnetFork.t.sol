// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "../../src/IERC20.sol";
import { ILiquidationAdapter } from "../../src/ILiquidationAdapter.sol";
import { AaveLiquidationAdapter } from "../../src/adapters/AaveLiquidationAdapter.sol";
import { AaveYieldAdapter } from "../../src/adapters/AaveYieldAdapter.sol";
import { MorphoLiquidationAdapter } from "../../src/adapters/MorphoLiquidationAdapter.sol";
import { EulerLiquidationAdapter } from "../../src/adapters/EulerLiquidationAdapter.sol";
import { IMorphoBlue } from "../../src/adapters/MorphoYieldAdapter.sol";
import { TestBase } from "../TestBase.sol";

interface IAavePoolFork {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    function getAssetPrice(address asset) external view returns (uint256);

    function getReserveTokensAddresses(address asset)
        external
        view
        returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress);
}

interface IERC20AllowanceFork {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IWethFork {
    function deposit() external payable;
}

interface IMorphoBlueFork {
    function isIrmEnabled(address irm) external view returns (bool);
    function isLltvEnabled(uint256 lltv) external view returns (bool);
    function createMarket(IMorphoBlue.MarketParams calldata marketParams) external;

    function supply(
        IMorphoBlue.MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        bytes calldata data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);

    function supplyCollateral(
        IMorphoBlue.MarketParams calldata marketParams,
        uint256 assets,
        address onBehalfOf,
        bytes calldata data
    ) external;

    function borrow(
        IMorphoBlue.MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    function accrueInterest(IMorphoBlue.MarketParams calldata marketParams) external;
    function market(bytes32 id) external view returns (IMorphoBlue.Market memory);
}

interface IEulerFactoryFork {
    function implementation() external view returns (address);
    function getProxyListLength() external view returns (uint256);
    function proxyList(uint256 index) external view returns (address);

    function createProxy(address desiredImplementation, bool upgradeable, bytes calldata trailingData)
        external
        returns (address proxy);
}

interface IEulerVaultFork {
    function asset() external view returns (address);
    function balanceOf(address owner) external view returns (uint256 shares);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function maxWithdraw(address owner) external view returns (uint256 assets);
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);
    function setHookConfig(address newHookTarget, uint32 newHookedOps) external;
    function setLTV(address collateral, uint16 borrowLTV, uint16 liquidationLTV, uint32 rampDuration) external;
    function borrow(uint256 assets, address receiver) external returns (uint256 shares);
    function liquidate(address violator, address collateral, uint256 repayAssets, uint256 minYieldBalance) external;
    function repay(uint256 assets, address account) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function checkLiquidation(address liquidator, address violator, address collateral)
        external
        view
        returns (uint256 maxRepay, uint256 maxYield);
}

interface IEvcFork {
    function enableCollateral(address account, address vault) external;
    function enableController(address account, address vault) external;
}

interface IAerodromeFactoryFork {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool);
}

interface IAerodromeRouterFork {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes)
        external
        view
        returns (uint256[] memory amounts);
}

interface IAerodromePoolFork {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256 amountOut);
}

contract ForkB20 {
    string public constant name = "Fork Control B20";
    string public constant symbol = "B20";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        uint256 approved = allowance[owner][msg.sender];
        require(approved >= amount, "ALLOWANCE");
        allowance[owner][msg.sender] = approved - amount;
        _transfer(owner, recipient, amount);
        return true;
    }

    function _transfer(address owner, address recipient, uint256 amount) internal {
        require(balanceOf[owner] >= amount, "BALANCE");
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
    }
}

contract ForkMutableOracle {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant PRICE_SCALE = 1e24;
    uint256 internal constant EULER_QUOTE_SCALE = 1e36;
    uint256 private _price;

    constructor(uint256 initialPrice) {
        _price = initialPrice;
    }

    function price() external view returns (uint256) {
        return _price;
    }

    function getPrice(address, address) external view returns (uint256) {
        return _price;
    }

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
        if (quote == USDC) return inAmount * _price / EULER_QUOTE_SCALE;
        if (base == USDC) return inAmount * EULER_QUOTE_SCALE / _price;
        revert("PAIR");
    }

    function getQuotes(uint256 inAmount, address base, address quote)
        external
        view
        returns (uint256 bid, uint256 ask)
    {
        bid = getQuote(inAmount, base, quote);
        ask = bid;
    }

    function setPrice(uint256 nextPrice) external {
        require(nextPrice != 0, "PRICE");
        _price = nextPrice;
    }
}

contract VenueMainnetForkTest is TestBase {
    uint256 internal constant FORK_BLOCK = 51_068_301;
    // Base USDC's FiatToken balance mapping is at slot 9 at the pinned block.
    uint256 internal constant USDC_BALANCES_SLOT = 9;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_USDC_ATOKEN = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;

    address internal constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant MORPHO_ADAPTIVE_CURVE_IRM =
        0x46415998764C29aB2a25CbeA6254146D50D22687;
    address internal constant EULER_EVC = 0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989;
    address internal constant EULER_EVAULT_FACTORY = 0x7F321498A801A191a93C840750ed637149dDf8D0;
    address internal constant EULER_EVAULT_IMPLEMENTATION =
        0x30a9A9654804F1e5b3291a86E83EdeD7cF281618;
    address internal constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant AERODROME_POOL_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    ForkMutableOracle internal eulerOracle;
    ForkB20 internal eulerCollateralToken;

    function test_I_FORK_1_AaveYield() public {
        _selectForkOrSkip();
        _logCase("I-FORK-1");

        uint256 amount = 1_000_000;
        _dealUsdc(address(this), amount);
        AaveYieldAdapter adapter = new AaveYieldAdapter(USDC, AAVE_POOL, AAVE_USDC_ATOKEN);
        require(IERC20(USDC).approve(address(adapter), amount), "USDC_APPROVAL_FAILED");
        assertEq(adapter.deposit(amount), amount);

        uint256 measuredAssets = adapter.totalAssets();
        assertTrue(measuredAssets <= amount);
        assertTrue(amount - measuredAssets <= 2);
        uint256 withdrawable = adapter.maxWithdraw();
        assertEq(withdrawable, measuredAssets);
        uint256 balanceBefore = IERC20(USDC).balanceOf(address(this));
        assertEq(adapter.withdraw(withdrawable, address(this)), measuredAssets);
        assertEq(IERC20(USDC).balanceOf(address(this)) - balanceBefore, measuredAssets);
        assertEq(adapter.totalAssets(), 0);
    }

    function test_I_FORK_2_MorphoForkCreatedMarketYield() public {
        _selectForkOrSkip();
        _logCase("I-FORK-2");

        ForkB20 collateral = new ForkB20();
        ForkMutableOracle oracle = new ForkMutableOracle(1e24);
        IMorphoBlue.MarketParams memory params = IMorphoBlue.MarketParams({
            loanToken: USDC,
            collateralToken: address(collateral),
            oracle: address(oracle),
            irm: MORPHO_ADAPTIVE_CURVE_IRM,
            lltv: _enabledMorphoLltv()
        });
        assertTrue(IMorphoBlueFork(MORPHO_BLUE).isIrmEnabled(params.irm));
        IMorphoBlueFork(MORPHO_BLUE).createMarket(params);

        _dealUsdc(address(this), 100_000_000);
        require(IERC20(USDC).approve(MORPHO_BLUE, 100_000_000), "USDC_APPROVAL_FAILED");
        IMorphoBlueFork(MORPHO_BLUE).supply(params, 100_000_000, 0, address(this), bytes(""));
        collateral.mint(address(this), 100 ether);
        require(IERC20(address(collateral)).approve(MORPHO_BLUE, 100 ether), "B20_APPROVAL_FAILED");
        IMorphoBlueFork(MORPHO_BLUE).supplyCollateral(params, 100 ether, address(this), bytes(""));
        IMorphoBlueFork(MORPHO_BLUE).borrow(params, 10_000_000, 0, address(this), address(this));

        vm.warp(block.timestamp + 3_600);
        IMorphoBlueFork(MORPHO_BLUE).accrueInterest(params);
        IMorphoBlue.Market memory current =
            IMorphoBlueFork(MORPHO_BLUE).market(keccak256(abi.encode(params)));
        assertTrue(current.totalSupplyAssets >= 100_000_000);
        assertTrue(current.totalBorrowAssets >= 10_000_000);
    }

    function test_I_FORK_3_EulerForkCreatedVaultYield() public {
        _selectForkOrSkip();
        _logCase("I-FORK-3");

        (address debtVault,) = _createEulerVaults();
        uint256 amount = 1_000_000;
        _dealUsdc(address(this), amount);
        require(IERC20(USDC).approve(debtVault, amount), "USDC_APPROVAL_FAILED");
        uint256 shares = IEulerVaultFork(debtVault).deposit(amount, address(this));
        assertTrue(shares != 0);
        uint256 withdrawable = IEulerVaultFork(debtVault).maxWithdraw(address(this));
        assertTrue(withdrawable != 0);
        assertTrue(IEulerVaultFork(debtVault).withdraw(withdrawable, address(this), address(this)) != 0);
        assertEq(IEulerVaultFork(debtVault).maxWithdraw(address(this)), 0);
    }

    function test_I_FORK_4A_AaveWethLiquidation() public {
        _selectForkOrSkip();
        _logCase("I-FORK-4A");

        address borrower = address(0xBEEF4A);
        uint256 collateralAmount = 10 ether;
        vm.deal(borrower, collateralAmount);
        vm.prank(borrower);
        IWethFork(WETH).deposit{ value: collateralAmount }();
        vm.prank(borrower);
        require(IERC20(WETH).approve(AAVE_POOL, collateralAmount), "WETH_APPROVAL_FAILED");
        vm.prank(borrower);
        IAavePoolFork(AAVE_POOL).supply(WETH, collateralAmount, borrower, 0);

        (uint256 collateralBase,, uint256 availableBorrowsBase,,,) = IAavePoolFork(AAVE_POOL)
            .getUserAccountData(borrower);
        assertTrue(collateralBase != 0);
        // Aave's Base oracle has no configured source for the native USDC
        // reserve at this pinned block, so getAssetPrice(USDC) reverts even
        // though the reserve is active. Aave's base currency is USD and
        // native USDC is six-decimal $1 debt; use that canonical conversion
        // while deriving the borrow from the live account-data result.
        uint256 borrowAmount = availableBorrowsBase * 990_000 / 100_000_000;
        assertTrue(borrowAmount != 0);
        vm.prank(borrower);
        IAavePoolFork(AAVE_POOL).borrow(USDC, borrowAmount, 2, 0, borrower);

        uint256 healthFactor = type(uint256).max;
        uint256 progressionTimestamp = block.timestamp;
        uint256 progressionBlock = block.number;
        for (uint256 i; i < 100 && healthFactor >= 1e18; ++i) {
            progressionTimestamp += 365 days;
            progressionBlock += 1;
            vm.warp(progressionTimestamp);
            vm.roll(progressionBlock);
            (,,,,, healthFactor) = IAavePoolFork(AAVE_POOL).getUserAccountData(borrower);
        }
        assertTrue(healthFactor < 1e18);

        AaveLiquidationAdapter adapter =
            new AaveLiquidationAdapter(AAVE_POOL, USDC, WETH, keccak256("KATON_BASE_AAVE_WETH"));
        _dealUsdc(address(this), borrowAmount);
        require(IERC20(USDC).approve(address(adapter), borrowAmount), "USDC_APPROVAL_FAILED");
        uint256 recipientBefore = IERC20(WETH).balanceOf(address(this));
        (uint256 repaid, uint256 seized) = adapter.liquidate(
            _request(
                keccak256("KATON_BASE_AAVE_WETH"),
                borrower,
                USDC,
                WETH,
                borrowAmount,
                1
            )
        );
        assertTrue(repaid != 0);
        assertTrue(seized != 0);
        assertEq(IERC20(WETH).balanceOf(address(this)) - recipientBefore, seized);
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0);
        assertEq(IERC20(WETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20AllowanceFork(USDC).allowance(address(adapter), AAVE_POOL), 0);
    }

    function test_I_FORK_5_MorphoControlledB20Liquidation() public {
        _selectForkOrSkip();
        _logCase("I-FORK-5");

        ForkB20 collateral = new ForkB20();
        ForkMutableOracle oracle = new ForkMutableOracle(1e24);
        IMorphoBlue.MarketParams memory params = _createMorphoMarket(collateral, oracle);
        _dealUsdc(address(this), 100_000_000);
        require(IERC20(USDC).approve(MORPHO_BLUE, 100_000_000), "USDC_APPROVAL_FAILED");
        IMorphoBlueFork(MORPHO_BLUE).supply(params, 100_000_000, 0, address(this), bytes(""));
        collateral.mint(address(this), 100 ether);
        require(IERC20(address(collateral)).approve(MORPHO_BLUE, 100 ether), "B20_APPROVAL_FAILED");
        IMorphoBlueFork(MORPHO_BLUE).supplyCollateral(params, 100 ether, address(this), bytes(""));
        IMorphoBlueFork(MORPHO_BLUE).borrow(params, 10_000_000, 0, address(this), address(this));
        // This remains below the LLTV threshold while preserving enough
        // collateral for Morpho's liquidation incentive and share rounding.
        oracle.setPrice(11e22);

        MorphoLiquidationAdapter adapter = new MorphoLiquidationAdapter(MORPHO_BLUE, params);
        _dealUsdc(address(this), 10_000_000);
        require(IERC20(USDC).approve(address(adapter), 10_000_000), "USDC_APPROVAL_FAILED");
        (uint256 repaid, uint256 seized) = adapter.liquidate(_request(
            keccak256(abi.encode(params)), address(this), USDC, address(collateral), 10_000_000, 0
        ));
        assertTrue(repaid != 0);
        assertTrue(seized != 0);
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0);
        assertEq(IERC20(address(collateral)).balanceOf(address(adapter)), 0);
        assertTrue(IERC20(address(collateral)).balanceOf(address(this)) != 0);
    }

    function test_I_FORK_6_EulerControlledB20Liquidation() public {
        _selectForkOrSkip();
        _logCase("I-FORK-6");

        (address debtVault, address collateralVault) = _createEulerVaults();
        IEulerVaultFork(debtVault).setLTV(collateralVault, 7_500, 8_000, 0);

        address borrower = address(0xBEEF6);
        vm.prank(borrower);
        IEvcFork(EULER_EVC).enableCollateral(borrower, collateralVault);
        vm.prank(borrower);
        IEvcFork(EULER_EVC).enableController(borrower, debtVault);

        _dealUsdc(address(this), 100_000_000);
        require(IERC20(USDC).approve(debtVault, 100_000_000), "USDC_APPROVAL_FAILED");
        IEulerVaultFork(debtVault).deposit(100_000_000, address(this));
        eulerCollateralToken.mint(borrower, 100 ether);
        vm.prank(borrower);
        require(eulerCollateralToken.approve(collateralVault, 100 ether), "B20_APPROVAL_FAILED");
        vm.prank(borrower);
        IEulerVaultFork(collateralVault).deposit(100 ether, borrower);
        vm.prank(borrower);
        IEulerVaultFork(debtVault).borrow(10_000_000, borrower);

        EulerLiquidationAdapter adapter = new EulerLiquidationAdapter(
            debtVault,
            collateralVault,
            USDC,
            keccak256("KATON_BASE_EULER_B20")
        );
        // Keep the account unhealthy while leaving enough collateral for the
        // liquidation bonus and the protocol's rounded share conversion.
        eulerOracle.setPrice(11e22);
        (uint256 maxRepay, uint256 maxYield) = IEulerVaultFork(debtVault)
            .checkLiquidation(address(adapter), borrower, collateralVault);
        assertTrue(maxRepay != 0);
        assertTrue(maxYield != 0);

        _dealUsdc(address(this), maxRepay);
        require(IERC20(USDC).approve(address(adapter), maxRepay), "USDC_APPROVAL_FAILED");
        uint256 recipientBefore = eulerCollateralToken.balanceOf(address(this));
        (uint256 repaid, uint256 seized) = adapter.liquidate(
            _request(
                keccak256("KATON_BASE_EULER_B20"),
                borrower,
                USDC,
                address(eulerCollateralToken),
                maxRepay,
                1
            )
        );
        assertTrue(repaid != 0);
        assertTrue(seized != 0);
        assertEq(eulerCollateralToken.balanceOf(address(this)) - recipientBefore, seized);
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0);
        assertEq(eulerCollateralToken.balanceOf(address(adapter)), 0);
        assertEq(IERC20AllowanceFork(USDC).allowance(address(adapter), debtVault), 0);
    }

    function test_I_FORK_7_AerodromeQuoteMatchesPool() public {
        _selectForkOrSkip();
        _logCase("I-FORK-7");

        address pool = IAerodromeFactoryFork(AERODROME_POOL_FACTORY).getPool(USDC, WETH, false);
        bool stable;
        if (pool == address(0)) {
            pool = IAerodromeFactoryFork(AERODROME_POOL_FACTORY).getPool(USDC, WETH, true);
            stable = true;
        }
        assertTrue(pool != address(0));
        uint256 amountIn = 1_000_000;
        uint256 direct = IAerodromePoolFork(pool).getAmountOut(amountIn, USDC);
        IAerodromeRouterFork.Route[] memory routes = new IAerodromeRouterFork.Route[](1);
        routes[0] = IAerodromeRouterFork.Route({
            from: USDC,
            to: WETH,
            stable: stable,
            factory: AERODROME_POOL_FACTORY
        });
        uint256[] memory routed = IAerodromeRouterFork(AERODROME_ROUTER).getAmountsOut(amountIn, routes);
        assertEq(routed[routed.length - 1], direct);
    }

    function test_I_FORK_8_PinnedProtocolBytecodeHashes() public {
        _selectForkOrSkip();
        _logCase("I-FORK-8");

        if (_latestMode()) {
            _assertCodePresent(AAVE_POOL);
            _assertCodePresent(MORPHO_BLUE);
            _assertCodePresent(EULER_EVC);
            _assertCodePresent(EULER_EVAULT_FACTORY);
            _assertCodePresent(AERODROME_ROUTER);
            return;
        }
        _assertCodeHash(
            AAVE_POOL, 0xffcb26fbebbe09d9b0d8baef76a1fa218989be6c279b7acf9865d8fb6e0718ce
        );
        _assertCodeHash(
            0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D,
            0xefb34c67e8737046b820be55b2ee18d57d78eca48058175a3dde822d69b4fa69
        );
        _assertCodeHash(
            AAVE_USDC_ATOKEN, 0x59d2fd2a4bad76f979bc2c1da50504e072f4b3bb64f5429302a384ad9c0706f2
        );
        _assertCodeHash(
            MORPHO_BLUE, 0xaa76348c0b91e5dfcece228ef6847b0c5081656d2def05c5617bcab659f0b819
        );
        _assertCodeHash(
            MORPHO_ADAPTIVE_CURVE_IRM,
            0x9978b522abfe0f3b8279800375d833b9d9660ae4f6321a2efb1f1f98850a0cbe
        );
        _assertCodeHash(
            EULER_EVC, 0xe8b9512aa6d72c962cf217bbaae14b79c8aca550694aab39740786a7c092a209
        );
        _assertCodeHash(
            EULER_EVAULT_FACTORY,
            0xb704ec88e9e85d56e174489031f21abaf401df5d156b374bd6ce6a76e4ba3277
        );
        _assertCodeHash(
            EULER_EVAULT_IMPLEMENTATION,
            0x12e23fbec62747fb792706c24a7444a049f86fdf333cbd1bf5f3cb839ca1eb3c
        );
        _assertCodeHash(
            AERODROME_ROUTER, 0x8efb4345abb93beb898eb5674f03118003594d744fcb9eb0f261cf942b609146
        );
        _assertCodeHash(
            AERODROME_POOL_FACTORY,
            0xe2a176e5d2bcfb214b784ec6d6733708a6376a464f203cc265c284c9f349fea3
        );
    }

    function _createMorphoMarket(ForkB20 collateral, ForkMutableOracle oracle)
        internal
        returns (IMorphoBlue.MarketParams memory params)
    {
        params = IMorphoBlue.MarketParams({
            loanToken: USDC,
            collateralToken: address(collateral),
            oracle: address(oracle),
            irm: MORPHO_ADAPTIVE_CURVE_IRM,
            lltv: _enabledMorphoLltv()
        });
        assertTrue(IMorphoBlueFork(MORPHO_BLUE).isIrmEnabled(params.irm));
        IMorphoBlueFork(MORPHO_BLUE).createMarket(params);
    }

    function _dealUsdc(address account, uint256 amount) internal {
        vm.store(
            USDC,
            keccak256(abi.encode(account, USDC_BALANCES_SLOT)),
            bytes32(amount)
        );
    }

    function _enabledMorphoLltv() internal view returns (uint256) {
        uint256[5] memory candidates = [
            uint256(800_000_000_000_000_000),
            uint256(860_000_000_000_000_000),
            uint256(770_000_000_000_000_000),
            uint256(650_000_000_000_000_000),
            uint256(500_000_000_000_000_000)
        ];
        for (uint256 i; i < candidates.length; ++i) {
            if (IMorphoBlueFork(MORPHO_BLUE).isLltvEnabled(candidates[i])) return candidates[i];
        }
        revert("NO_ENABLED_LLTV");
    }

    function _createEulerVaults() internal returns (address debtVault, address collateralVault) {
        assertEq(IEulerFactoryFork(EULER_EVAULT_FACTORY).implementation(), EULER_EVAULT_IMPLEMENTATION);
        uint256 first = IEulerFactoryFork(EULER_EVAULT_FACTORY).getProxyListLength();
        eulerOracle = new ForkMutableOracle(1e24);
        eulerCollateralToken = new ForkB20();
        // GenericFactory prepends the four-byte zero prefix.  Pass only the
        // three 20-byte metadata addresses required by ProxyUtils.
        bytes memory debtMetadata = abi.encodePacked(USDC, address(eulerOracle), USDC);
        bytes memory collateralMetadata = abi.encodePacked(
            address(eulerCollateralToken), address(eulerOracle), USDC
        );
        IEulerFactoryFork(EULER_EVAULT_FACTORY).createProxy(
            EULER_EVAULT_IMPLEMENTATION, false, debtMetadata
        );
        IEulerFactoryFork(EULER_EVAULT_FACTORY).createProxy(
            EULER_EVAULT_IMPLEMENTATION, false, collateralMetadata
        );
        debtVault = IEulerFactoryFork(EULER_EVAULT_FACTORY).proxyList(first);
        collateralVault = IEulerFactoryFork(EULER_EVAULT_FACTORY).proxyList(first + 1);
        assertEq(IEulerVaultFork(debtVault).asset(), USDC);
        assertEq(IEulerVaultFork(collateralVault).asset(), address(eulerCollateralToken));
        // Fresh EVK vaults start with every operation disabled. The factory
        // caller is the proxy governor for these fork-created fixtures, so
        // clear the default disabled-operation flags while leaving the hook
        // target unset (no hook is installed in these controlled fixtures).
        IEulerVaultFork(debtVault).setHookConfig(address(0), 0);
        IEulerVaultFork(collateralVault).setHookConfig(address(0), 0);
        assertTrue(EULER_EVC.code.length != 0);
    }

    function _request(
        bytes32 marketId,
        address borrower,
        address debtAsset,
        address collateralAsset,
        uint256 maxRepayAssets,
        uint256 minCollateralOut
    ) internal view returns (ILiquidationAdapter.Request memory request) {
        request = ILiquidationAdapter.Request({
            marketId: marketId,
            borrower: borrower,
            debtAsset: debtAsset,
            collateralAsset: collateralAsset,
            maxRepayAssets: maxRepayAssets,
            minCollateralOut: minCollateralOut,
            recipient: address(this)
        });
    }

    function _selectForkOrSkip() internal {
        string memory profile = vm.envOr("FOUNDRY_PROFILE", "");
        if (keccak256(bytes(profile)) != keccak256(bytes("fork"))) {
            vm.skip(true);
            return;
        }
        string memory rpcUrl = vm.envOr("BASE_FORK_RPC", "");
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return;
        }
        if (_latestMode()) vm.createSelectFork(rpcUrl);
        else vm.createSelectFork(rpcUrl, FORK_BLOCK);
        assertEq(block.chainid, 8453);
        if (!_latestMode()) assertEq(block.number, FORK_BLOCK);
    }

    function _latestMode() internal returns (bool) {
        return keccak256(bytes(vm.envOr("BASE_FORK_LATEST", "")))
            == keccak256(bytes("true"));
    }

    // The case identifier is encoded in each test function name.  Keeping
    // this helper as a no-op avoids depending on version-specific logging
    // cheatcodes while preserving the explicit case markers in forge output.
    function _logCase(string memory) internal pure {}

    function _assertCodePresent(address target) internal view {
        uint256 size;
        assembly {
            size := extcodesize(target)
        }
        assertTrue(size != 0);
    }

    function _assertCodeHash(address target, bytes32 expected) internal view {
        bytes32 actual;
        assembly {
            actual := extcodehash(target)
        }
        assertEq(actual, expected);
    }
}
