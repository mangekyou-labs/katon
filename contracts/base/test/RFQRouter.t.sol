// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { BaseEIP712 } from "../src/BaseEIP712.sol";
import { IRFQRouter } from "../src/IRFQRouter.sol";
import { IRFQSettlement } from "../src/IRFQSettlement.sol";
import { IB20Guard } from "../src/IB20Guard.sol";
import { IOracleGuard } from "../src/IOracleGuard.sol";
import { MockERC20 } from "./MockERC20.sol";
import { MockFacilityAdapter } from "./MockFacilityAdapter.sol";
import { MockLiquidationAdapter } from "./MockLiquidationAdapter.sol";
import { RFQRouter } from "../src/RFQRouter.sol";
import { RFQSettlement } from "../src/RFQSettlement.sol";
import { LiquidityFacility } from "../src/LiquidityFacility.sol";
import { TestBase } from "./TestBase.sol";

contract MockOracleGuard is IOracleGuard {
    bool public blocked;

    function configureFeed(address, address, uint256) external { }

    function setGracePeriod(uint256) external { }

    function setBlocked(bool value) external {
        blocked = value;
    }

    function requireFresh(address) external view {
        if (blocked) revert("ORACLE_BLOCKED");
    }

    function snapshot(address) external pure returns (int256, uint256, uint8, bool, uint256, bool) {
        return (1, 1, 8, true, 1, false);
    }
}

contract MockB20Guard is IB20Guard {
    bool public blocked;
    address public blockedRecipient;

    function setBlocked(bool value) external {
        blocked = value;
    }

    function setBlockedRecipient(address recipient) external {
        blockedRecipient = recipient;
    }

    function requireTransferAndSeizeLive(address) external view {
        if (blocked) revert("B20_BLOCKED");
    }

    function requireTransferAuthorized(address, address, address recipient) external view {
        if (blocked || recipient == blockedRecipient) revert("B20_AUTH_BLOCKED");
    }

    function multiplierWad(address) external pure returns (uint256) {
        return 1e18;
    }

    function scaledBalanceOf(address, address) external pure returns (uint256) {
        return 0;
    }
}

contract RFQRouterTest is TestBase {
    uint256 internal constant MAKER_KEY = 0xA11CE;
    MockERC20 internal usdc;
    MockERC20 internal collateral;
    RFQSettlement internal settlement;
    RFQRouter internal router;
    MockOracleGuard internal oracleGuard;
    MockB20Guard internal b20Guard;
    MockLiquidationAdapter internal adapter;
    LiquidityFacility internal facility;
    MockFacilityAdapter internal facilityAdapter;
    address internal maker;
    address internal constant FACILITY_EXECUTOR = address(0xEceC);
    address internal constant FACILITY_GUARDIAN = address(0x6AAD);
    address internal constant FACILITY_CURATOR = address(0xC0A7);
    address internal facilityDepositor = address(0xD0);

    function setUp() public {
        usdc = new MockERC20();
        collateral = new MockERC20();
        settlement = new RFQSettlement(address(usdc));
        router = new RFQRouter();
        oracleGuard = new MockOracleGuard();
        b20Guard = new MockB20Guard();
        router.setOracleGuard(address(oracleGuard));
        router.setB20Guard(address(b20Guard));
        settlement.setRouter(address(router));
        adapter = new MockLiquidationAdapter(address(collateral));
        router.setSettlement(address(settlement), true);
        router.setLiquidationAdapter(address(adapter), true);
        router.setMaxDecisionBlockAge(3);
        maker = vm.addr(MAKER_KEY);
        usdc.mint(maker, 1_000);
        vm.prank(maker);
        usdc.approve(address(settlement), 1_000);

        facility = new LiquidityFacility(
            address(usdc), FACILITY_CURATOR, FACILITY_EXECUTOR, FACILITY_GUARDIAN
        );
        facilityAdapter = new MockFacilityAdapter(address(usdc));
        facility.setRouter(address(router));
        router.setFacility(address(facility), true);
        usdc.mint(facilityDepositor, 300);
        vm.prank(facilityDepositor);
        usdc.approve(address(facility), 300);
        vm.prank(facilityDepositor);
        facility.deposit(300, facilityDepositor);
        vm.prank(FACILITY_CURATOR);
        facility.setAdapterAllowed(address(facilityAdapter), true);
    }

    function testLpRouteUsesTypedAdapterAndDualMinimums() public {
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(1, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 60, 80);

        vm.prank(maker);
        (uint256 repaid, uint256 seized, uint256 fee) = router.executeLiquidationRoute(plan);
        assertEq(repaid, 100);
        assertEq(seized, 100);
        assertEq(fee, 0);
        assertEq(collateral.balanceOf(maker), 100);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 100);
        assertEq(adapter.lastRecipient(), address(router));
    }

    function testLpRouteBooksMeasuredPartialRepaymentAndRefundsUnusedFunding() public {
        adapter.setDebtConsumed(60);
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(16, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);
        uint256 makerBefore = usdc.balanceOf(maker);

        vm.prank(maker);
        (uint256 repaid, uint256 seized, uint256 fee) = router.executeLiquidationRoute(plan);

        assertEq(repaid, 60);
        assertEq(seized, 100);
        assertEq(fee, 0);
        assertEq(usdc.balanceOf(maker), makerBefore - 60);
        assertEq(usdc.balanceOf(address(adapter)), 60);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(collateral.balanceOf(address(router)), 0);
        assertEq(usdc.allowance(address(router), address(adapter)), 0);
        assertEq(settlement.pendingFunding(_orderHash(order)), 0);
        assertEq(settlement.filled(_orderHash(order)), 60);
    }

    function testFillOrKillPartialVenueConsumptionRollsBackFundingAndVenue() public {
        adapter.setDebtConsumed(60);
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(17, 0);
        order.fillMode = 0;
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);
        uint256 makerBefore = usdc.balanceOf(maker);

        vm.expectRevert(bytes("FILL_OR_KILL"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);

        assertEq(usdc.balanceOf(maker), makerBefore);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(collateral.balanceOf(address(adapter)), 100);
        assertEq(settlement.pendingFunding(_orderHash(order)), 0);
        assertEq(settlement.filled(_orderHash(order)), 0);
        assertTrue(!router.usedRfqIds(plan.rfqId));
    }

    function testAdapterReportMismatchRevertsBeforeAnyNewTokenDust() public {
        adapter.setDebtConsumed(60);
        adapter.setCollateralOut(100);
        adapter.setReportedValues(61, 100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(18, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);

        vm.expectRevert(bytes("ADAPTER_ACCOUNTING_MISMATCH"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);

        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(collateral.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(collateral.balanceOf(address(adapter)), 100);
        assertEq(usdc.allowance(address(router), address(adapter)), 0);
    }

    function testNetCollateralMustMeetBothMinimums() public {
        adapter.setCollateralOut(99);
        collateral.mint(address(adapter), 99);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(2, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 100, 90);

        vm.expectRevert(bytes("MIN_OUT"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(collateral.balanceOf(maker), 0);
    }

    function testOneFeeIsAppliedAfterGrossBalanceDelta() public {
        router.setFeeRecipient(address(0xFEE));
        router.setFeeBps(50);
        adapter.setCollateralOut(10_000);
        collateral.mint(address(adapter), 10_000);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(3, 9_950);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 9_950, 9_950);

        vm.prank(maker);
        (,, uint256 fee) = router.executeLiquidationRoute(plan);
        assertEq(fee, 50);
        assertEq(collateral.balanceOf(maker), 9_950);
        assertEq(collateral.balanceOf(address(0xFEE)), 50);
    }

    function testWinnerSenderAndDecisionAgeAreEnforced() public {
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(4, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);

        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("UNAUTHORIZED"));
        router.executeLiquidationRoute(plan);

        vm.roll(block.number + 5);
        vm.expectRevert(bytes("STALE_DECISION"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
    }

    function testUnallowlistedAdapterAndHealthyVenueRevert() public {
        IRFQSettlement.LiquidationFundingOrder memory order = _order(5, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);
        plan.liquidationAdapter = address(0xBAD);
        vm.expectRevert(bytes("ADAPTER_NOT_ALLOWED"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);

        plan = _plan(order, 0, 0);
        adapter.setHealthy(true);
        vm.expectRevert(bytes("HEALTHY"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
    }

    function testFundingPayloadCannotCarryArbitraryTrailingCalldata() public {
        IRFQSettlement.LiquidationFundingOrder memory order = _order(7, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);
        plan.fundingPayload = bytes.concat(plan.fundingPayload, hex"00");
        vm.expectRevert(bytes("INVALID_PAYLOAD"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
    }

    function testOneOffOrderRfqMustMatchRouteRfq() public {
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(14, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);
        plan.rfqId = bytes32(uint256(0xCAFE));

        vm.expectRevert(bytes("RFQ_MISMATCH"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function testSignedVenueMustMatchSelectedAdapter() public {
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(15, 0);
        order.venue = address(0xCAFE);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);

        vm.expectRevert(bytes("VENUE_MISMATCH"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function testFeeCapIsRejected() public {
        vm.expectRevert(bytes("FEE_CAP"));
        router.setFeeBps(51);
    }

    function testFacilitySourceIsNoLongerUnsupported() public {
        IRFQSettlement.LiquidationFundingOrder memory order = _order(6, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);
        plan.source = IRFQRouter.FundingSource.FACILITY;
        vm.expectRevert(bytes("FACILITY_NOT_ALLOWED"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
    }

    function testFacilityRouteUsesExecutorBorrowerAndBooksInventoryAtCost() public {
        facilityAdapter.setWithdrawLimit(250);
        vm.prank(FACILITY_CURATOR);
        facility.allocate(address(facilityAdapter), 250);
        vm.prank(facilityDepositor);
        facility.requestWithdraw(50);

        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQRouter.LiquidationRoutePlan memory plan = _facilityPlan(150, 100);

        uint256 beforeAssets = facility.totalAssets();
        vm.prank(FACILITY_EXECUTOR);
        (uint256 repaid, uint256 seized, uint256 fee) = router.executeLiquidationRoute(plan);

        assertEq(repaid, 150);
        assertEq(seized, 100);
        assertEq(fee, 0);
        assertEq(adapter.lastBorrower(), plan.borrower);
        assertEq(adapter.lastMarketId(), bytes32(uint256(0xBEEF)));
        assertEq(facility.inventoryAtAcquisitionCost(), 150);
        (address token, uint256 amount, uint256 usdcPaid) = facility.inventoryLots(0);
        assertEq(token, address(collateral));
        assertEq(amount, 100);
        assertEq(usdcPaid, 150);
        assertEq(facility.totalAssets(), beforeAssets);
        assertEq(collateral.balanceOf(address(facility)), 100);
        assertEq(usdc.balanceOf(address(adapter)), 150);
    }

    function testFacilityRouteRefundsUnusedFundingAndBooksActualAcquisitionCost() public {
        facilityAdapter.setWithdrawLimit(250);
        vm.prank(FACILITY_CURATOR);
        facility.allocate(address(facilityAdapter), 250);
        vm.prank(facilityDepositor);
        facility.requestWithdraw(50);

        adapter.setDebtConsumed(60);
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQRouter.LiquidationRoutePlan memory plan = _facilityPlan(150, 0);
        uint256 beforeAssets = facility.totalAssets();

        vm.prank(FACILITY_EXECUTOR);
        (uint256 repaid, uint256 seized,) = router.executeLiquidationRoute(plan);

        assertEq(repaid, 60);
        assertEq(seized, 100);
        assertEq(facility.inventoryAtAcquisitionCost(), 60);
        assertEq(facility.totalAssets(), beforeAssets);
        assertEq(facility.pendingFundedUsdc(), 0);
        assertEq(facility.pendingFundedBlock(), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.allowance(address(router), address(facility)), 0);
        assertEq(usdc.allowance(address(router), address(adapter)), 0);
        assertEq(collateral.balanceOf(address(router)), 0);
    }

    function testFacilityRouteRejectsKeeperWinnerAndRecipientMismatch() public {
        IRFQRouter.LiquidationRoutePlan memory plan = _facilityPlan(100, 0);

        vm.expectRevert(bytes("UNAUTHORIZED"));
        vm.prank(address(0xBEEF));
        router.executeLiquidationRoute(plan);

        plan.recipient = address(0xCAFE);
        vm.expectRevert(bytes("INVALID_FACILITY_RECIPIENT"));
        vm.prank(FACILITY_EXECUTOR);
        router.executeLiquidationRoute(plan);

        plan = _facilityPlan(100, 0);
        plan.winner = address(0xCAFE);
        vm.expectRevert(bytes("UNAUTHORIZED"));
        vm.prank(address(0xCAFE));
        router.executeLiquidationRoute(plan);
    }

    function testGuardsAreRequiredAndUnsetRouterFailsClosedBeforeFunding() public {
        RFQRouter unsetRouter = new RFQRouter();
        unsetRouter.setSettlement(address(settlement), true);
        unsetRouter.setLiquidationAdapter(address(adapter), true);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(9, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);

        vm.expectRevert(bytes("ORACLE_GUARD_UNSET"));
        vm.prank(maker);
        unsetRouter.executeLiquidationRoute(plan);
        assertEq(usdc.balanceOf(address(unsetRouter)), 0);
        assertTrue(!unsetRouter.usedRfqIds(plan.rfqId));
    }

    function testOracleGuardRunsBeforeFundingAndAdapter() public {
        oracleGuard.setBlocked(true);
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(10, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);

        vm.expectRevert(bytes("ORACLE_BLOCKED"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertTrue(!router.usedRfqIds(plan.rfqId));
    }

    function testB20GuardRunsBeforeFundingAndAdapter() public {
        b20Guard.setBlocked(true);
        adapter.setCollateralOut(100);
        collateral.mint(address(adapter), 100);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(11, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);

        vm.expectRevert(bytes("B20_BLOCKED"));
        vm.prank(maker);
        router.executeLiquidationRoute(plan);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertTrue(!router.usedRfqIds(plan.rfqId));
    }

    function testFeeRecipientAuthorizationIsCheckedOnlyWhenFeesAreEnabled() public {
        address feeRecipient = address(0xFEE);
        b20Guard.setBlockedRecipient(feeRecipient);
        router.setFeeRecipient(feeRecipient);
        adapter.setCollateralOut(10_000);
        collateral.mint(address(adapter), 10_000);
        IRFQSettlement.LiquidationFundingOrder memory order = _order(12, 0);
        IRFQRouter.LiquidationRoutePlan memory plan = _plan(order, 0, 0);

        vm.prank(maker);
        router.executeLiquidationRoute(plan);
        assertEq(collateral.balanceOf(maker), 10_000);

        router.setFeeBps(50);
        IRFQSettlement.LiquidationFundingOrder memory feeOrder = _order(13, 0);
        IRFQRouter.LiquidationRoutePlan memory feePlan = _plan(feeOrder, 0, 0);
        vm.expectRevert(bytes("B20_AUTH_BLOCKED"));
        vm.prank(maker);
        router.executeLiquidationRoute(feePlan);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertTrue(!router.usedRfqIds(feePlan.rfqId));
    }

    function testFacilityPayloadMustBeExactAndFacilityMustBeAllowlisted() public {
        IRFQRouter.LiquidationRoutePlan memory plan = _facilityPlan(100, 0);
        plan.fundingPayload = bytes.concat(plan.fundingPayload, hex"00");
        vm.expectRevert(bytes("INVALID_PAYLOAD"));
        vm.prank(FACILITY_EXECUTOR);
        router.executeLiquidationRoute(plan);

        plan = _facilityPlan(100, 0);
        router.setFacility(address(facility), false);
        vm.expectRevert(bytes("FACILITY_NOT_ALLOWED"));
        vm.prank(FACILITY_EXECUTOR);
        router.executeLiquidationRoute(plan);
    }

    function testSwapRouteSettlesSignedMakerOrderForTaker() public {
        address taker = address(0xBEEF);
        uint256 stockAmount = 100;
        uint256 usdcAmount = 10_000;
        collateral.mint(taker, stockAmount);
        usdc.mint(maker, usdcAmount);
        vm.prank(taker);
        collateral.approve(address(settlement), stockAmount);
        vm.prank(maker);
        usdc.approve(address(settlement), usdcAmount);

        bytes32 requestId = bytes32(uint256(0xCAFE));
        IRFQSettlement.SwapOrder memory order = IRFQSettlement.SwapOrder({
            maker: maker,
            signer: maker,
            stockToken: address(collateral),
            usdcToken: address(usdc),
            stockAmount: stockAmount,
            usdcAmount: usdcAmount,
            fillMode: 1,
            expiry: block.timestamp + 1 days,
            salt: 42,
            feeCapBps: 50,
            allowedTaker: taker,
            rfqId: requestId
        });
        IRFQRouter.SwapRoutePlan memory plan = IRFQRouter.SwapRoutePlan({
            requestId: requestId,
            taker: taker,
            recipient: taker,
            stockToken: address(collateral),
            usdcToken: address(usdc),
            settlement: address(settlement),
            sellAmount: stockAmount,
            minBuyAmount: usdcAmount,
            feeCapBps: 50,
            deadline: block.timestamp + 1 days,
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0)
        });
        IRFQRouter.SwapRouteLeg[] memory legs = new IRFQRouter.SwapRouteLeg[](1);
        legs[0] = IRFQRouter.SwapRouteLeg({
            source: IRFQRouter.SwapLiquiditySource.LP,
            liquidity: maker,
            stockAmount: stockAmount,
            minUsdcOut: usdcAmount,
            payload: abi.encode(order, _signSwap(order))
        });

        vm.prank(taker);
        (uint256 boughtUsdc, uint256 fee) = router.executeSwapRoute(plan, legs);

        assertEq(boughtUsdc, usdcAmount);
        assertEq(fee, 0);
        assertEq(collateral.balanceOf(maker), stockAmount);
        assertEq(collateral.balanceOf(taker), 0);
        assertEq(usdc.balanceOf(taker), usdcAmount);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(settlement.swapFilled(_swapOrderHash(order)), stockAmount);
    }

    function testSwapRouteRejectsNonCanonicalMakerPayload() public {
        address taker = address(0xBEEF);
        uint256 stockAmount = 100;
        uint256 usdcAmount = 10_000;
        collateral.mint(taker, stockAmount);
        usdc.mint(maker, usdcAmount);
        vm.prank(taker);
        collateral.approve(address(settlement), stockAmount);
        vm.prank(maker);
        usdc.approve(address(settlement), usdcAmount);

        bytes32 requestId = bytes32(uint256(0xCAFE2));
        IRFQSettlement.SwapOrder memory order = IRFQSettlement.SwapOrder({
            maker: maker,
            signer: maker,
            stockToken: address(collateral),
            usdcToken: address(usdc),
            stockAmount: stockAmount,
            usdcAmount: usdcAmount,
            fillMode: 1,
            expiry: block.timestamp + 1 days,
            salt: 43,
            feeCapBps: 50,
            allowedTaker: taker,
            rfqId: requestId
        });
        IRFQRouter.SwapRoutePlan memory plan = IRFQRouter.SwapRoutePlan({
            requestId: requestId,
            taker: taker,
            recipient: taker,
            stockToken: address(collateral),
            usdcToken: address(usdc),
            settlement: address(settlement),
            sellAmount: stockAmount,
            minBuyAmount: usdcAmount,
            feeCapBps: 50,
            deadline: block.timestamp + 1 days,
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0)
        });
        IRFQRouter.SwapRouteLeg[] memory legs = new IRFQRouter.SwapRouteLeg[](1);
        legs[0] = IRFQRouter.SwapRouteLeg({
            source: IRFQRouter.SwapLiquiditySource.LP,
            liquidity: maker,
            stockAmount: stockAmount,
            minUsdcOut: usdcAmount,
            payload: bytes.concat(abi.encode(order, _signSwap(order)), hex"00")
        });

        vm.expectRevert(bytes("INVALID_PAYLOAD"));
        vm.prank(taker);
        router.executeSwapRoute(plan, legs);
    }

    function _order(uint256 salt, uint256 minOut)
        internal
        view
        returns (IRFQSettlement.LiquidationFundingOrder memory)
    {
        return IRFQSettlement.LiquidationFundingOrder({
            maker: maker,
            signer: maker,
            debtAsset: address(usdc),
            collateralAsset: address(collateral),
            maxRepayAssets: 100,
            minCollateralOut: minOut,
            fillMode: 1,
            expiry: block.timestamp + 1 days,
            salt: salt,
            feeLimitBps: 50,
            rfqId: bytes32(salt),
            venue: address(0),
            marketId: bytes32(uint256(0x99))
        });
    }

    function _plan(
        IRFQSettlement.LiquidationFundingOrder memory order,
        uint256 rfqMin,
        uint256 funderMin
    ) internal returns (IRFQRouter.LiquidationRoutePlan memory plan) {
        bytes memory signature = _sign(order);
        plan = IRFQRouter.LiquidationRoutePlan({
            rfqId: order.rfqId,
            winner: maker,
            recipient: maker,
            borrower: address(0),
            deadline: block.timestamp + 1 days,
            source: IRFQRouter.FundingSource.LP,
            settlementOrFacility: address(settlement),
            liquidationAdapter: address(adapter),
            repayAssets: order.maxRepayAssets,
            minCollateralOutRfq: rfqMin,
            minCollateralOutFunder: funderMin,
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            fundingPayload: abi.encode(order, signature)
        });
    }

    function _facilityPlan(uint256 repayAssets, uint256 minCollateralOut)
        internal
        view
        returns (IRFQRouter.LiquidationRoutePlan memory plan)
    {
        bytes32 marketId = bytes32(uint256(0xBEEF));
        address borrower = address(0xB0BB);
        bytes32 rfqId = bytes32(uint256(0xFACADE));
        plan = IRFQRouter.LiquidationRoutePlan({
            rfqId: rfqId,
            winner: FACILITY_EXECUTOR,
            recipient: address(facility),
            borrower: borrower,
            deadline: block.timestamp + 1 days,
            source: IRFQRouter.FundingSource.FACILITY,
            settlementOrFacility: address(facility),
            liquidationAdapter: address(adapter),
            repayAssets: repayAssets,
            minCollateralOutRfq: minCollateralOut,
            minCollateralOutFunder: minCollateralOut,
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            fundingPayload: abi.encode(rfqId, marketId, address(usdc), address(collateral))
        });
    }

    function _sign(IRFQSettlement.LiquidationFundingOrder memory order)
        internal
        returns (bytes memory)
    {
        BaseEIP712.LiquidationFundingOrder memory typedOrder =
            BaseEIP712.LiquidationFundingOrder({
                maker: order.maker,
                signer: order.signer,
                debtAsset: order.debtAsset,
                collateralAsset: order.collateralAsset,
                maxRepayAssets: order.maxRepayAssets,
                minCollateralOut: order.minCollateralOut,
                fillMode: order.fillMode,
                expiry: order.expiry,
                salt: order.salt,
                feeLimitBps: order.feeLimitBps,
                rfqId: order.rfqId,
                venue: order.venue,
                marketId: order.marketId
            });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            MAKER_KEY,
            BaseEIP712.hashLiquidationFundingOrder(typedOrder, block.chainid, address(settlement))
        );
        return abi.encodePacked(r, s, v);
    }

    function _orderHash(IRFQSettlement.LiquidationFundingOrder memory order)
        internal
        view
        returns (bytes32)
    {
        BaseEIP712.LiquidationFundingOrder memory typedOrder = BaseEIP712.LiquidationFundingOrder({
            maker: order.maker,
            signer: order.signer,
            debtAsset: order.debtAsset,
            collateralAsset: order.collateralAsset,
            maxRepayAssets: order.maxRepayAssets,
            minCollateralOut: order.minCollateralOut,
            fillMode: order.fillMode,
            expiry: order.expiry,
            salt: order.salt,
            feeLimitBps: order.feeLimitBps,
            rfqId: order.rfqId,
            venue: order.venue,
            marketId: order.marketId
        });
        return BaseEIP712.hashLiquidationFundingOrder(typedOrder, block.chainid, address(settlement));
    }

    function _signSwap(IRFQSettlement.SwapOrder memory order)
        internal
        returns (bytes memory)
    {
        BaseEIP712.SwapOrder memory typedOrder = BaseEIP712.SwapOrder({
            maker: order.maker,
            signer: order.signer,
            stockToken: order.stockToken,
            usdcToken: order.usdcToken,
            stockAmount: order.stockAmount,
            usdcAmount: order.usdcAmount,
            fillMode: order.fillMode,
            expiry: order.expiry,
            salt: order.salt,
            feeCapBps: order.feeCapBps,
            allowedTaker: order.allowedTaker,
            rfqId: order.rfqId
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            MAKER_KEY,
            BaseEIP712.hashSwapOrder(typedOrder, block.chainid, address(settlement))
        );
        return abi.encodePacked(r, s, v);
    }

    function _swapOrderHash(IRFQSettlement.SwapOrder memory order)
        internal
        view
        returns (bytes32)
    {
        BaseEIP712.SwapOrder memory typedOrder = BaseEIP712.SwapOrder({
            maker: order.maker,
            signer: order.signer,
            stockToken: order.stockToken,
            usdcToken: order.usdcToken,
            stockAmount: order.stockAmount,
            usdcAmount: order.usdcAmount,
            fillMode: order.fillMode,
            expiry: order.expiry,
            salt: order.salt,
            feeCapBps: order.feeCapBps,
            allowedTaker: order.allowedTaker,
            rfqId: order.rfqId
        });
        return BaseEIP712.hashSwapOrder(typedOrder, block.chainid, address(settlement));
    }
}
