// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {RFQRouter} from "../src/RFQRouter.sol";
import {KineticYieldAdapter} from "../src/adapters/KineticYieldAdapter.sol";
import {KineticLiquidationAdapter} from "../src/adapters/KineticLiquidationAdapter.sol";
import {ClearpoolYieldAdapter} from "../src/adapters/ClearpoolYieldAdapter.sol";

interface IERC20Fork {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IKineticForkMarket {
    function underlying() external view returns (address);
    function comptroller() external view returns (address);
    function getCash() external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function borrowBalanceStored(address account) external view returns (uint256);
    function mint(uint256 amount) external returns (uint256 errorCode);
    function borrow(uint256 amount) external returns (uint256 errorCode);
    function accrueInterest() external returns (uint256 errorCode);
}

interface IKineticForkComptroller {
    function enterMarkets(address[] calldata markets) external returns (uint256[] memory results);
    function getAccountLiquidity(address account)
        external
        view
        returns (uint256 errorCode, uint256 liquidity, uint256 shortfall);
    function getHypotheticalAccountLiquidity(
        address account,
        address market,
        uint256 redeemTokens,
        uint256 borrowAmount
    ) external view returns (uint256 errorCode, uint256 liquidity, uint256 shortfall);
    function closeFactorMantissa() external view returns (uint256);
    function liquidatorsWhitelistVerifier() external view returns (address);
}

interface IKineticForkLiquidatorAllowList {
    function owner() external view returns (address);
    function allow(address account) external;
    function allowed(address account) external view returns (bool);
}

interface IClearpoolForkPool {
    function asset() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function cash() external view returns (uint256);
    function totalRewards(address rewardAsset)
        external
        view
        returns (uint256 accumulated, uint256 withdrawn);
}

contract ForkKineticFccQuorum {
    mapping(bytes32 => bytes32) private selected;

    function set(bytes32 actionId, bytes32 resultHash) external {
        selected[actionId] = resultHash;
    }

    function quorum(bytes32 actionId) external view returns (bool ready, bytes32 selectedHash) {
        selectedHash = selected[actionId];
        ready = selectedHash != bytes32(0);
    }
}

contract ForkKineticFundingSource {
    address public immutable debtToken;

    constructor(address debtToken_) {
        debtToken = debtToken_;
    }

    function fund(address recipient, address expectedDebtToken, uint256 requested)
        external
        returns (uint256 funded)
    {
        require(expectedDebtToken == debtToken && requested > 0, "FUNDING_BINDING");
        require(IERC20Fork(debtToken).transfer(recipient, requested), "FUNDING_TRANSFER");
        return requested;
    }
}

/// @dev Real Flare-mainnet fork coverage. Setting FLARE_MAINNET_RPC_URL opts into the
/// suite; once opted in, a positive pinned FLARE_MAINNET_FORK_BLOCK is mandatory.
contract VenueMainnetForkTest is TestBase {
    address private constant KINETIC_UNITROLLER = 0x8041680Fb73E1Fe5F851e76233DCDfA0f2D2D7c8;
    address private constant KINETIC_LIQUIDATOR_ALLOWLIST =
        0x5fa1B6Cdc8E46BfFEed066E1ECd92F90C663e8CC;
    address private constant KINETIC_USDT0_MARKET = 0x76809aBd690B77488Ffb5277e0a8300a7e77B779;
    address private constant KINETIC_SFLR_MARKET = 0x291487beC339c2fE5D83DD45F0a15EFC9Ac45656;
    address private constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address private constant SFLR = 0x12e605bc104e93B45e1aD99F9e555f659051c2BB;
    address private constant USDX = 0x4A771Cc1a39FDd8AA08B8EA51F7Fd412e73B3d2B;
    address private constant CLEARPOOL_T_POOL = 0xFE2907DFa8DB6e320cDbF45f0aa888F6135ec4f8;
    address private constant MORPHO_CORE = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address private constant MORPHO_VAULT_V2_FACTORY = 0x6FC83ECc0e8142635D77200e5052be8A0a9D2f42;
    bytes32 private constant KINETIC_MARKET_ID = keccak256("kinetic-usdt0-mainnet");
    bytes32 private constant CLEARPOOL_MARKET_ID = keccak256("clearpool-usdx-tpool-mainnet");
    address private constant KINETIC_BORROWER = 0xb0B1400000000000000000000000000000000014;
    address private constant LIQUIDATION_RECIPIENT = address(0xcafe);
    bytes32 private constant LIQUIDATION_POLICY = keccak256("kinetic-mainnet-fork-liquidator");
    bytes32 private constant LIQUIDATION_ISSUER = keccak256("kinetic-mainnet-fork-issuer");
    uint256 private constant LIQUIDATOR_ROLE = 8;

    struct KineticLiquidationFixture {
        KineticLiquidationAdapter adapter;
        uint256 debtOutstanding;
        uint256 maxRepay;
    }

    struct KineticRouterFixture {
        RFQRouter router;
        ForkKineticFccQuorum fcc;
        ForkKineticFundingSource funding;
        KineticLiquidationAdapter adapter;
        uint256 debtOutstanding;
        uint256 maxRepay;
    }

    function testForkKineticOfficialBindings() public {
        if (!_selectPinnedFork()) return;

        assertEq(block.chainid, 14);
        assertTrue(KINETIC_UNITROLLER.code.length > 0);
        assertTrue(KINETIC_LIQUIDATOR_ALLOWLIST.code.length > 0);
        assertEq(
            IKineticForkComptroller(KINETIC_UNITROLLER).liquidatorsWhitelistVerifier(),
            KINETIC_LIQUIDATOR_ALLOWLIST
        );
        assertTrue(
            IKineticForkLiquidatorAllowList(KINETIC_LIQUIDATOR_ALLOWLIST).owner()
                != address(0)
        );
        assertTrue(KINETIC_USDT0_MARKET.code.length > 0);
        assertTrue(USDT0.code.length > 0);
        assertEq(IKineticForkMarket(KINETIC_USDT0_MARKET).underlying(), USDT0);
        assertEq(IKineticForkMarket(KINETIC_USDT0_MARKET).comptroller(), KINETIC_UNITROLLER);
        assertTrue(IKineticForkMarket(KINETIC_USDT0_MARKET).exchangeRateStored() > 0);
        assertTrue(KINETIC_SFLR_MARKET.code.length > 0);
        assertTrue(SFLR.code.length > 0);
        assertEq(IKineticForkMarket(KINETIC_SFLR_MARKET).underlying(), SFLR);
        assertEq(IKineticForkMarket(KINETIC_SFLR_MARKET).comptroller(), KINETIC_UNITROLLER);
    }

    function testForkKineticDepositAndApprovalCleanup() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1_000_000);
        assertEq(adapter.deposit(1_000_000), 1_000_000);
        assertEq(IERC20Fork(USDT0).allowance(address(adapter), KINETIC_USDT0_MARKET), 0);
    }

    function testForkKineticAccrualValuationRead() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1_000_000);
        adapter.deposit(1_000_000);
        assertTrue(adapter.totalAssets() > 0);
        assertTrue(adapter.totalAssets() <= 1_000_000);
    }

    function testForkKineticWithdrawalToRecipient() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1_000_000);
        adapter.deposit(1_000_000);
        uint256 recipientBefore = IERC20Fork(USDT0).balanceOf(address(0xcafe));
        uint256 withdrawable = adapter.maxWithdraw();
        assertTrue(withdrawable > 0);
        assertEq(adapter.withdraw(withdrawable, address(0xcafe)), withdrawable);
        assertEq(IERC20Fork(USDT0).balanceOf(address(0xcafe)), recipientBefore + withdrawable);
        assertEq(IERC20Fork(USDT0).allowance(address(adapter), KINETIC_USDT0_MARKET), 0);
    }

    function testForkKineticPauseRejection() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1_000_000);
        adapter.pause();
        vm.expectRevert(bytes("ADAPTER_PAUSED"));
        adapter.deposit(1_000_000);
    }

    function testForkKineticCallerRejection() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1_000_000);
        vm.prank(address(0xbad));
        vm.expectRevert(bytes("ADAPTER_CALLER"));
        adapter.deposit(1_000_000);
    }

    function testForkKineticWrongAssetRejection() public {
        if (!_selectPinnedFork()) return;

        vm.expectRevert(bytes("KINETIC_ASSET"));
        new KineticYieldAdapter(address(this), USDX, KINETIC_USDT0_MARKET, KINETIC_MARKET_ID);
    }

    function testForkKineticOverBalanceWithdrawalRejection() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1_000_000);
        adapter.deposit(1_000_000);
        uint256 assetsBefore = adapter.totalAssets();
        vm.expectRevert(bytes("LIQUIDITY"));
        adapter.withdraw(assetsBefore + 1, address(0xcafe));
        assertEq(adapter.totalAssets(), assetsBefore);
    }

    function testForkKineticOneBaseUnitRoundTrip() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1);
        assertEq(adapter.deposit(1), 1);
        assertEq(adapter.maxWithdraw(), 1);
        uint256 recipientBefore = IERC20Fork(USDT0).balanceOf(address(0xcafe));
        assertEq(adapter.withdraw(1, address(0xcafe)), 1);
        assertEq(IERC20Fork(USDT0).balanceOf(address(0xcafe)), recipientBefore + 1);
        assertEq(adapter.totalAssets(), 0);
    }

    function testForkKineticZeroLiquidityCapsWithdrawalAndPreservesPosition() public {
        if (!_selectPinnedFork()) return;

        KineticYieldAdapter adapter = _fundedKineticAdapter(1_000_000);
        adapter.deposit(1_000_000);
        uint256 assetsBefore = adapter.totalAssets();
        uint256 cash = IKineticForkMarket(KINETIC_USDT0_MARKET).getCash();
        assertTrue(cash > 0);

        vm.prank(KINETIC_USDT0_MARKET);
        assertTrue(IERC20Fork(USDT0).transfer(address(0xdead), cash));
        assertEq(adapter.maxWithdraw(), 0);
        vm.expectRevert(bytes("LIQUIDITY"));
        adapter.withdraw(1, address(0xcafe));
        assertEq(adapter.totalAssets(), assetsBefore);
    }

    function testForkKineticLiquidatorAllowlistRejection() public {
        if (!_selectPinnedFork()) return;

        uint256 debtOutstanding = _createUnhealthyKineticPosition();
        KineticLiquidationAdapter adapter = _kineticLiquidationAdapter();
        IKineticForkLiquidatorAllowList allowList = _kineticLiquidatorAllowList();
        require(!allowList.allowed(address(adapter)), "KINETIC_ADAPTER_ALREADY_ALLOWED");
        uint256 maxRepay = _kineticMaxClose(debtOutstanding);
        require(maxRepay > 0, "KINETIC_ZERO_CLOSE");
        _fundAndApproveKineticAdapter(adapter, maxRepay);
        uint256 debtBefore =
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER);
        uint256 collateralBefore =
            IKineticForkMarket(KINETIC_SFLR_MARKET).balanceOf(KINETIC_BORROWER);
        uint256 borrowerFundingBefore = IERC20Fork(USDT0).balanceOf(KINETIC_BORROWER);

        vm.prank(KINETIC_BORROWER);
        vm.expectRevert(bytes("KINETIC_LIQUIDATE"));
        adapter.liquidate(
            KINETIC_UNITROLLER,
            KINETIC_USDT0_MARKET,
            _kineticPosition(),
            USDT0,
            SFLR,
            maxRepay,
            LIQUIDATION_RECIPIENT,
            ""
        );

        assertEq(
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER),
            debtBefore
        );
        assertEq(
            IKineticForkMarket(KINETIC_SFLR_MARKET).balanceOf(KINETIC_BORROWER),
            collateralBefore
        );
        assertEq(IERC20Fork(USDT0).balanceOf(KINETIC_BORROWER), borrowerFundingBefore);
        assertEq(IERC20Fork(USDT0).balanceOf(address(adapter)), 0);
        assertEq(IERC20Fork(USDT0).allowance(address(adapter), KINETIC_USDT0_MARKET), 0);
        assertEq(IERC20Fork(KINETIC_SFLR_MARKET).balanceOf(address(adapter)), 0);
    }

    function testForkKineticLiquidationRouteSuccess() public {
        if (!_selectPinnedFork()) return;

        KineticRouterFixture memory fixture = _kineticRouterFixture();
        RFQRouter.LiquidationRoutePlan memory route =
            _kineticRoute(fixture, 1, keccak256("kinetic-liquidation-success"));
        fixture.fcc.set(route.fccActionId, fixture.router.hashLiquidationRoute(route));
        uint256 recipientBefore = IERC20Fork(SFLR).balanceOf(LIQUIDATION_RECIPIENT);
        uint256 feeBefore = IERC20Fork(SFLR).balanceOf(address(this));

        fixture.router.executeLiquidationRoute(route);

        uint256 recipientDelta =
            IERC20Fork(SFLR).balanceOf(LIQUIDATION_RECIPIENT) - recipientBefore;
        uint256 feeDelta = IERC20Fork(SFLR).balanceOf(address(this)) - feeBefore;
        assertTrue(recipientDelta > 0);
        assertTrue(feeDelta > 0);
        assertTrue(
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER)
                < fixture.debtOutstanding
        );
        assertEq(IERC20Fork(USDT0).allowance(address(fixture.router), address(fixture.adapter)), 0);
        assertEq(IERC20Fork(USDT0).allowance(address(fixture.adapter), KINETIC_USDT0_MARKET), 0);
        assertEq(IERC20Fork(KINETIC_SFLR_MARKET).balanceOf(address(fixture.adapter)), 0);
    }

    function testForkKineticHealthyPositionRejection() public {
        if (!_selectPinnedFork()) return;

        KineticLiquidationAdapter adapter = _kineticLiquidationAdapter();
        vm.expectRevert(bytes("LIQUIDATION_HEALTH"));
        adapter.liquidate(
            KINETIC_UNITROLLER,
            KINETIC_USDT0_MARKET,
            _kineticPosition(),
            USDT0,
            SFLR,
            1,
            LIQUIDATION_RECIPIENT,
            ""
        );
    }

    function testForkKineticCloseFactorRejection() public {
        if (!_selectPinnedFork()) return;

        KineticLiquidationFixture memory fixture = _kineticLiquidationFixture();
        vm.expectRevert(bytes("LIQUIDATION_CLOSE_FACTOR"));
        fixture.adapter.liquidate(
            KINETIC_UNITROLLER,
            KINETIC_USDT0_MARKET,
            _kineticPosition(),
            USDT0,
            SFLR,
            fixture.maxRepay + 1,
            LIQUIDATION_RECIPIENT,
            ""
        );
    }

    function testForkKineticRouterMinimumOutputRollback() public {
        if (!_selectPinnedFork()) return;

        KineticRouterFixture memory fixture = _kineticRouterFixture();
        RFQRouter.LiquidationRoutePlan memory route = _kineticRoute(
            fixture, type(uint256).max, keccak256("kinetic-liquidation-min-output")
        );
        fixture.fcc.set(route.fccActionId, fixture.router.hashLiquidationRoute(route));
        uint256 sourceBefore = IERC20Fork(USDT0).balanceOf(address(fixture.funding));
        uint256 debtBefore =
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER);
        uint256 collateralBefore =
            IKineticForkMarket(KINETIC_SFLR_MARKET).balanceOf(KINETIC_BORROWER);

        vm.expectRevert(bytes("MIN_OUTPUT"));
        fixture.router.executeLiquidationRoute(route);

        assertEq(IERC20Fork(USDT0).balanceOf(address(fixture.funding)), sourceBefore);
        assertEq(
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER),
            debtBefore
        );
        assertEq(IKineticForkMarket(KINETIC_SFLR_MARKET).balanceOf(KINETIC_BORROWER), collateralBefore);
        assertEq(IERC20Fork(USDT0).allowance(address(fixture.router), address(fixture.adapter)), 0);
        assertEq(IERC20Fork(USDT0).allowance(address(fixture.adapter), KINETIC_USDT0_MARKET), 0);
    }

    function testForkKineticLiquidationApprovalCleanup() public {
        if (!_selectPinnedFork()) return;

        KineticLiquidationFixture memory fixture = _kineticLiquidationFixture();
        _fundAndApproveKineticAdapter(fixture.adapter, fixture.maxRepay);
        uint256 recipientBefore = IERC20Fork(SFLR).balanceOf(LIQUIDATION_RECIPIENT);

        vm.prank(KINETIC_BORROWER);
        assertEq(
            fixture.adapter.liquidate(
                KINETIC_UNITROLLER,
                KINETIC_USDT0_MARKET,
                _kineticPosition(),
                USDT0,
                SFLR,
                fixture.maxRepay,
                LIQUIDATION_RECIPIENT,
                ""
            ),
            fixture.maxRepay
        );

        assertTrue(IERC20Fork(SFLR).balanceOf(LIQUIDATION_RECIPIENT) > recipientBefore);
        assertEq(IERC20Fork(USDT0).allowance(address(fixture.adapter), KINETIC_USDT0_MARKET), 0);
        assertEq(IERC20Fork(KINETIC_SFLR_MARKET).balanceOf(address(fixture.adapter)), 0);
        assertEq(IERC20Fork(SFLR).balanceOf(address(fixture.adapter)), 0);
    }

    function testForkKineticLiquidationRecipientRejection() public {
        if (!_selectPinnedFork()) return;

        KineticLiquidationAdapter adapter = _kineticLiquidationAdapter();
        vm.expectRevert(bytes("RECIPIENT"));
        adapter.liquidate(
            KINETIC_UNITROLLER,
            KINETIC_USDT0_MARKET,
            _kineticPosition(),
            USDT0,
            SFLR,
            1,
            address(0),
            ""
        );
    }

    function testForkKineticRedemptionFailureAtomicRollback() public {
        if (!_selectPinnedFork()) return;

        KineticLiquidationFixture memory fixture = _kineticLiquidationFixture();
        _fundAndApproveKineticAdapter(fixture.adapter, fixture.maxRepay);
        uint256 debtBefore =
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER);
        uint256 collateralBefore =
            IKineticForkMarket(KINETIC_SFLR_MARKET).balanceOf(KINETIC_BORROWER);
        uint256 borrowerFundingBefore = IERC20Fork(USDT0).balanceOf(KINETIC_BORROWER);
        uint256 collateralCash = IKineticForkMarket(KINETIC_SFLR_MARKET).getCash();
        require(collateralCash > 0, "KINETIC_COLLATERAL_CASH");
        vm.prank(KINETIC_SFLR_MARKET);
        require(IERC20Fork(SFLR).transfer(address(0xdead), collateralCash), "KINETIC_DRAIN");

        vm.prank(KINETIC_BORROWER);
        vm.expectRevert(bytes("KINETIC_REDEEM"));
        fixture.adapter.liquidate(
            KINETIC_UNITROLLER,
            KINETIC_USDT0_MARKET,
            _kineticPosition(),
            USDT0,
            SFLR,
            fixture.maxRepay,
            LIQUIDATION_RECIPIENT,
            ""
        );

        assertEq(
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER),
            debtBefore
        );
        assertEq(IKineticForkMarket(KINETIC_SFLR_MARKET).balanceOf(KINETIC_BORROWER), collateralBefore);
        assertEq(IERC20Fork(USDT0).balanceOf(KINETIC_BORROWER), borrowerFundingBefore);
        assertEq(IERC20Fork(USDT0).allowance(address(fixture.adapter), KINETIC_USDT0_MARKET), 0);
        assertEq(IERC20Fork(KINETIC_SFLR_MARKET).balanceOf(address(fixture.adapter)), 0);
    }

    function testForkClearpoolOfficialBindings() public {
        if (!_selectPinnedFork()) return;

        assertEq(block.chainid, 14);
        assertTrue(USDX.code.length > 0);
        assertTrue(CLEARPOOL_T_POOL.code.length > 0);
        assertEq(IClearpoolForkPool(CLEARPOOL_T_POOL).asset(), USDX);
        assertTrue(IClearpoolForkPool(CLEARPOOL_T_POOL).cash() > 0);
    }

    function testForkClearpoolDepositAndApprovalCleanup() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1_000_000);
        uint256 sharesBefore = IClearpoolForkPool(CLEARPOOL_T_POOL).balanceOf(address(adapter));
        assertEq(adapter.deposit(1_000_000), 1_000_000);
        assertEq(
            IClearpoolForkPool(CLEARPOOL_T_POOL).balanceOf(address(adapter)),
            sharesBefore + 1_000_000
        );
        assertEq(adapter.totalAssets(), 1_000_000);
        assertEq(IERC20Fork(USDX).allowance(address(adapter), CLEARPOOL_T_POOL), 0);
    }

    function testForkClearpoolRewardAccountingRead() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1_000_000);
        adapter.deposit(1_000_000);
        vm.prank(address(adapter));
        (uint256 accumulated, uint256 withdrawn) =
            IClearpoolForkPool(CLEARPOOL_T_POOL).totalRewards(USDX);
        assertTrue(accumulated >= withdrawn);
        assertEq(adapter.totalAssets(), 1_000_000);
    }

    function testForkClearpoolWithdrawalToRecipient() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1_000_000);
        adapter.deposit(1_000_000);
        uint256 recipientBefore = IERC20Fork(USDX).balanceOf(address(0xcafe));
        assertEq(adapter.withdraw(400_000, address(0xcafe)), 400_000);
        assertEq(IERC20Fork(USDX).balanceOf(address(0xcafe)), recipientBefore + 400_000);
        assertEq(adapter.totalAssets(), 600_000);
    }

    function testForkClearpoolZeroCashCapsWithdrawalAndPreservesShares() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1_000_000);
        adapter.deposit(1_000_000);
        uint256 sharesBefore = adapter.totalAssets();
        uint256 availableCash = IClearpoolForkPool(CLEARPOOL_T_POOL).cash();
        assertTrue(availableCash > 0);

        vm.prank(CLEARPOOL_T_POOL);
        assertTrue(IERC20Fork(USDX).transfer(address(0xdead), availableCash));
        assertEq(adapter.maxWithdraw(), 0);
        vm.expectRevert(bytes("LIQUIDITY"));
        adapter.withdraw(1, address(0xcafe));
        assertEq(adapter.totalAssets(), sharesBefore);
    }

    function testForkClearpoolOverBalanceWithdrawalRejection() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1_000_000);
        adapter.deposit(1_000_000);
        vm.expectRevert(bytes("LIQUIDITY"));
        adapter.withdraw(1_000_001, address(0xcafe));
        assertEq(adapter.totalAssets(), 1_000_000);
    }

    function testForkClearpoolOneBaseUnitRoundTrip() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1);
        assertEq(adapter.deposit(1), 1);
        assertEq(adapter.totalAssets(), 1);
        uint256 recipientBefore = IERC20Fork(USDX).balanceOf(address(0xcafe));
        assertEq(adapter.withdraw(1, address(0xcafe)), 1);
        assertEq(IERC20Fork(USDX).balanceOf(address(0xcafe)), recipientBefore + 1);
        assertEq(adapter.totalAssets(), 0);
    }

    function testForkClearpoolPauseRejection() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1_000_000);
        adapter.pause();
        vm.expectRevert(bytes("ADAPTER_PAUSED"));
        adapter.deposit(1_000_000);
    }

    function testForkClearpoolCallerRejection() public {
        if (!_selectPinnedFork()) return;

        ClearpoolYieldAdapter adapter = _fundedClearpoolAdapter(1_000_000);
        vm.prank(address(0xbad));
        vm.expectRevert(bytes("ADAPTER_CALLER"));
        adapter.deposit(1_000_000);
    }

    function testForkClearpoolWrongAssetRejection() public {
        if (!_selectPinnedFork()) return;

        vm.expectRevert(bytes("CLEARPOOL_USDX_ONLY"));
        new ClearpoolYieldAdapter(address(this), USDT0, CLEARPOOL_T_POOL, CLEARPOOL_MARKET_ID);
    }

    function testForkMorphoOfficialDeploymentsExist() public {
        if (!_selectPinnedFork()) return;

        assertTrue(MORPHO_CORE.code.length > 0);
        assertTrue(MORPHO_VAULT_V2_FACTORY.code.length > 0);
    }

    function _fundedKineticAdapter(uint256 amount) private returns (KineticYieldAdapter adapter) {
        adapter =
            new KineticYieldAdapter(address(this), USDT0, KINETIC_USDT0_MARKET, KINETIC_MARKET_ID);
        require(IKineticForkMarket(KINETIC_USDT0_MARKET).getCash() >= amount, "KINETIC_FORK_CASH");
        vm.prank(KINETIC_USDT0_MARKET);
        require(IERC20Fork(USDT0).transfer(address(adapter), amount), "KINETIC_FORK_SEED");
    }

    function _fundedClearpoolAdapter(uint256 amount) private returns (ClearpoolYieldAdapter adapter) {
        adapter = new ClearpoolYieldAdapter(address(this), USDX, CLEARPOOL_T_POOL, CLEARPOOL_MARKET_ID);
        require(IClearpoolForkPool(CLEARPOOL_T_POOL).cash() >= amount, "CLEARPOOL_FORK_CASH");
        vm.prank(CLEARPOOL_T_POOL);
        require(IERC20Fork(USDX).transfer(address(adapter), amount), "CLEARPOOL_FORK_SEED");
    }

    function _kineticLiquidationFixture()
        private
        returns (KineticLiquidationFixture memory fixture)
    {
        fixture.debtOutstanding = _createUnhealthyKineticPosition();
        fixture.adapter = _kineticLiquidationAdapter();
        _authorizeKineticAdapter(address(fixture.adapter));
        fixture.maxRepay = _kineticMaxClose(fixture.debtOutstanding);
        require(fixture.maxRepay > 0, "KINETIC_ZERO_CLOSE");
    }

    function _kineticRouterFixture() private returns (KineticRouterFixture memory fixture) {
        KineticLiquidationFixture memory liquidation = _kineticLiquidationFixture();
        fixture.adapter = liquidation.adapter;
        fixture.debtOutstanding = liquidation.debtOutstanding;
        fixture.maxRepay = liquidation.maxRepay;
        fixture.router = new RFQRouter();
        fixture.fcc = new ForkKineticFccQuorum();
        fixture.funding = new ForkKineticFundingSource(USDT0);
        EligibilityRegistry registry = new EligibilityRegistry();
        registry.setPolicy(
            LIQUIDATION_POLICY,
            address(this),
            LIQUIDATOR_ROLE,
            0,
            type(uint64).max,
            LIQUIDATION_ISSUER
        );
        fixture.router.setEligibilityRegistry(address(registry));
        fixture.router.setProtocolFeeBps(50);
        fixture.router.setFccQuorumVerifier(address(fixture.fcc));
        fixture.router.setLiquidationFundingSource(address(fixture.funding), true);
        fixture.router.setLiquidationAdapter(address(fixture.adapter), true);
        vm.prank(KINETIC_BORROWER);
        require(
            IERC20Fork(USDT0).transfer(address(fixture.funding), fixture.maxRepay),
            "KINETIC_FUNDING_SEED"
        );
    }

    function _kineticRoute(
        KineticRouterFixture memory fixture,
        uint256 minNetCollateral,
        bytes32 salt
    ) private view returns (RFQRouter.LiquidationRoutePlan memory route) {
        bytes32 commitment = keccak256(abi.encode(salt, block.number, address(fixture.adapter)));
        route = RFQRouter.LiquidationRoutePlan({
            chainId: block.chainid,
            router: address(fixture.router),
            commitment: commitment,
            fccActionId: keccak256(abi.encode("kinetic-fcc", commitment)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            winner: address(this),
            recipient: LIQUIDATION_RECIPIENT,
            venue: KINETIC_UNITROLLER,
            market: KINETIC_USDT0_MARKET,
            position: _kineticPosition(),
            debtToken: USDT0,
            collateralToken: SFLR,
            maxRepay: fixture.maxRepay,
            minNetCollateral: minNetCollateral,
            protocolFeeBps: 50,
            fundingSource: address(fixture.funding),
            liquidationAdapter: address(fixture.adapter),
            eligibilityPolicyId: LIQUIDATION_POLICY,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: LIQUIDATOR_ROLE,
            eligibilityIssuerReference: LIQUIDATION_ISSUER
        });
    }

    function _createUnhealthyKineticPosition() private returns (uint256 debtOutstanding) {
        uint256 collateralCash = IKineticForkMarket(KINETIC_SFLR_MARKET).getCash();
        uint256 collateralAmount = collateralCash / 1_000;
        if (collateralAmount > 100_000 ether) collateralAmount = 100_000 ether;
        require(collateralAmount >= 100 ether, "KINETIC_COLLATERAL_SEED");
        vm.prank(KINETIC_SFLR_MARKET);
        require(
            IERC20Fork(SFLR).transfer(KINETIC_BORROWER, collateralAmount),
            "KINETIC_COLLATERAL_TRANSFER"
        );
        vm.prank(KINETIC_BORROWER);
        require(
            IERC20Fork(SFLR).approve(KINETIC_SFLR_MARKET, collateralAmount),
            "KINETIC_COLLATERAL_APPROVE"
        );
        vm.prank(KINETIC_BORROWER);
        require(
            IKineticForkMarket(KINETIC_SFLR_MARKET).mint(collateralAmount) == 0,
            "KINETIC_COLLATERAL_MINT"
        );
        address[] memory markets = new address[](1);
        markets[0] = KINETIC_SFLR_MARKET;
        vm.prank(KINETIC_BORROWER);
        uint256[] memory enterResults = IKineticForkComptroller(KINETIC_UNITROLLER).enterMarkets(markets);
        require(enterResults.length == 1 && enterResults[0] == 0, "KINETIC_ENTER_MARKET");

        uint256 maximumHealthyBorrow = _maximumHealthyKineticBorrow();
        require(maximumHealthyBorrow > 1, "KINETIC_BORROW_CAPACITY");
        vm.prank(KINETIC_BORROWER);
        require(
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrow(maximumHealthyBorrow - 1) == 0,
            "KINETIC_BORROW"
        );

        (, uint256 liquidity, uint256 shortfall) =
            IKineticForkComptroller(KINETIC_UNITROLLER).getAccountLiquidity(KINETIC_BORROWER);
        for (uint256 i = 0; i < 24 && shortfall == 0; ++i) {
            vm.warp(block.timestamp + 1 hours);
            vm.roll(block.number + 1_800);
            require(
                IKineticForkMarket(KINETIC_USDT0_MARKET).accrueInterest() == 0,
                "KINETIC_ACCRUE"
            );
            (, liquidity, shortfall) =
                IKineticForkComptroller(KINETIC_UNITROLLER).getAccountLiquidity(KINETIC_BORROWER);
        }
        require(liquidity == 0 && shortfall > 0, "KINETIC_SHORTFALL_NOT_REACHED");
        debtOutstanding =
            IKineticForkMarket(KINETIC_USDT0_MARKET).borrowBalanceStored(KINETIC_BORROWER);
        require(debtOutstanding > 0, "KINETIC_DEBT");
    }

    function _maximumHealthyKineticBorrow() private view returns (uint256 maximum) {
        uint256 high = IKineticForkMarket(KINETIC_USDT0_MARKET).getCash();
        if (high > 100_000_000_000) high = 100_000_000_000;
        require(high > 0, "KINETIC_DEBT_CASH");
        while (maximum < high) {
            uint256 candidate = maximum + ((high - maximum + 1) / 2);
            (uint256 errorCode,, uint256 shortfall) = IKineticForkComptroller(KINETIC_UNITROLLER)
                .getHypotheticalAccountLiquidity(
                KINETIC_BORROWER, KINETIC_USDT0_MARKET, 0, candidate
            );
            if (errorCode == 0 && shortfall == 0) {
                maximum = candidate;
            } else {
                high = candidate - 1;
            }
        }
    }

    function _kineticLiquidationAdapter() private returns (KineticLiquidationAdapter adapter) {
        adapter = new KineticLiquidationAdapter(
            KINETIC_UNITROLLER,
            KINETIC_USDT0_MARKET,
            _kineticPosition(),
            USDT0,
            SFLR,
            KINETIC_SFLR_MARKET
        );
    }

    function _fundAndApproveKineticAdapter(KineticLiquidationAdapter adapter, uint256 amount) private {
        require(IERC20Fork(USDT0).balanceOf(KINETIC_BORROWER) >= amount, "KINETIC_DEBT_FUNDING");
        vm.prank(KINETIC_BORROWER);
        require(IERC20Fork(USDT0).approve(address(adapter), amount), "KINETIC_ADAPTER_APPROVE");
    }

    function _kineticLiquidatorAllowList()
        private
        view
        returns (IKineticForkLiquidatorAllowList allowList)
    {
        address verifier =
            IKineticForkComptroller(KINETIC_UNITROLLER).liquidatorsWhitelistVerifier();
        require(verifier == KINETIC_LIQUIDATOR_ALLOWLIST, "KINETIC_ALLOWLIST_BINDING");
        allowList = IKineticForkLiquidatorAllowList(verifier);
    }

    function _authorizeKineticAdapter(address adapter) private {
        // Model the real deployment prerequisite through Kinetic's own owner-only
        // method. This is fork setup, not evidence that this adapter is currently
        // authorized on mainnet.
        IKineticForkLiquidatorAllowList allowList = _kineticLiquidatorAllowList();
        require(!allowList.allowed(adapter), "KINETIC_ADAPTER_ALREADY_ALLOWED");
        address allowListOwner = allowList.owner();
        require(allowListOwner != address(0), "KINETIC_ALLOWLIST_OWNER");
        vm.prank(allowListOwner);
        allowList.allow(adapter);
        require(allowList.allowed(adapter), "KINETIC_ADAPTER_NOT_ALLOWED");
    }

    function _kineticMaxClose(uint256 debtOutstanding) private view returns (uint256) {
        uint256 closeFactor =
            IKineticForkComptroller(KINETIC_UNITROLLER).closeFactorMantissa();
        require(closeFactor > 0 && closeFactor <= 1e18, "KINETIC_CLOSE_FACTOR");
        return (debtOutstanding / 1e18) * closeFactor
            + ((debtOutstanding % 1e18) * closeFactor) / 1e18;
    }

    function _kineticPosition() private pure returns (bytes32) {
        return bytes32(uint256(uint160(KINETIC_BORROWER)));
    }

    function _selectPinnedFork() private returns (bool selected) {
        string memory rpcUrl = vm.envOr("FLARE_MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return false;
        }
        uint256 forkBlock = vm.envOr("FLARE_MAINNET_FORK_BLOCK", uint256(0));
        require(forkBlock > 0, "FLARE_FORK_BLOCK_REQUIRED");
        vm.createSelectFork(rpcUrl, forkBlock);
        return true;
    }
}
