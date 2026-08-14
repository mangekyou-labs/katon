// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {LiquidityFacility} from "../src/LiquidityFacility.sol";
import {RFQRouter} from "../src/RFQRouter.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";

contract FacilityMockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FacilityMockAdapter {
    FacilityMockERC20 public immutable token;

    constructor(FacilityMockERC20 token_) {
        token = token_;
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function deposit(uint256) external returns (uint256) {
        return 0;
    }

    function withdraw(uint256 amount, address receiver) external returns (uint256) {
        token.transfer(receiver, amount);
        return amount;
    }

    function totalAssets() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function maxWithdraw() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function accrue(uint256 amount) external {
        token.mint(address(this), amount);
    }
}

contract LiquidityFacilityTest is TestBase {
    address private lp = address(0xCAFE);
    address private seller = address(0xBEEF);
    FacilityMockERC20 private base;
    FacilityMockERC20 private rwa;
    FacilityMockAdapter private adapter;
    LiquidityFacility private facility;
    RFQRouter private router;
    EligibilityRegistry private registry;
    bytes32 private constant SELLER_POLICY = keccak256("facility-seller-policy");
    bytes32 private constant ISSUER_REFERENCE = keccak256("issuer");

    function setUp() public {
        base = new FacilityMockERC20();
        rwa = new FacilityMockERC20();
        adapter = new FacilityMockAdapter(base);
        facility = new LiquidityFacility(address(base));
        router = new RFQRouter();
        router.setLegacyRouteEnabled(true);
        facility.setRouter(address(router));

        base.mint(lp, 1_000 ether);
        rwa.mint(seller, 100 ether);
        vm.prank(lp);
        base.approve(address(facility), type(uint256).max);
        vm.prank(seller);
        rwa.approve(address(facility), type(uint256).max);
    }

    function testFacilityFillChecksSharedEligibilityPolicyAtExecution() public {
        registry = new EligibilityRegistry();
        registry.setPolicy(SELLER_POLICY, seller, 1, 0, type(uint64).max, ISSUER_REFERENCE);
        facility.setEligibilityRegistry(address(registry));
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(
            address(facility),
            100 ether,
            100 ether,
            abi.encode(SELLER_POLICY, uint256(0), uint256(1), ISSUER_REFERENCE)
        );

        vm.prank(seller);
        router.executeRoute(_route(100 ether, 100 ether, legs));
        assertEq(base.balanceOf(seller), 100 ether);

        registry.revoke(SELLER_POLICY);
        legs[0].sellAmount = 1 ether;
        legs[0].minOutput = 1 ether;
        RFQRouter.RoutePlan memory revokedRoute = _route(1 ether, 1 ether, legs);
        revokedRoute.commitment = bytes32(uint256(100));
        vm.expectRevert(bytes("SOURCE_CALL_FAILED"));
        vm.prank(seller);
        router.executeRoute(revokedRoute);
    }

    function testDepositsQueueWithdrawalsAndSettleAfterDeallocation() public {
        vm.prank(lp);
        assertEq(facility.deposit(1_000 ether, lp), 1_000 ether);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 1_000 ether);

        vm.prank(lp);
        uint256 requestId = facility.requestWithdraw(500 ether, lp, lp, 490 ether);
        vm.expectRevert(bytes("WITHDRAWAL_LIQUIDITY"));
        facility.settleWithdraw(requestId);

        facility.deallocate(address(adapter), 500 ether);
        facility.settleWithdraw(requestId);

        assertEq(base.balanceOf(lp), 500 ether);
        assertEq(facility.totalShares(), 500 ether);
    }

    function testSupportsStandardShareViewsAndSynchronousExits() public {
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        assertEq(facility.balanceOf(lp), 1_000 ether);
        assertEq(facility.convertToShares(250 ether), 250 ether);
        assertEq(facility.convertToAssets(250 ether), 250 ether);

        vm.prank(lp);
        facility.withdraw(400 ether, lp, lp);
        assertEq(base.balanceOf(lp), 400 ether);
        assertEq(facility.balanceOf(lp), 600 ether);

        vm.prank(lp);
        facility.redeem(100 ether, lp, lp);
        assertEq(base.balanceOf(lp), 500 ether);
        assertEq(facility.balanceOf(lp), 500 ether);
    }

    function testExposesStandardPreviewAndLimitViews() public {
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        assertEq(facility.previewDeposit(250 ether), 250 ether);
        assertEq(facility.previewMint(250 ether), 250 ether);
        assertEq(facility.previewWithdraw(250 ether), 250 ether);
        assertEq(facility.previewRedeem(250 ether), 250 ether);
        assertEq(facility.maxDeposit(lp), type(uint256).max);
        assertEq(facility.maxMint(lp), type(uint256).max);
        assertEq(facility.maxWithdraw(lp), 1_000 ether);
        assertEq(facility.maxRedeem(lp), 1_000 ether);

        facility.setRiskCaps(1_200 ether, 0, 0);
        assertEq(facility.maxDeposit(lp), 200 ether);
    }

    function testSynchronousExitRejectsDeployedLiquidity() public {
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 1_000 ether);
        vm.expectRevert(bytes("WITHDRAWAL_LIQUIDITY"));
        vm.prank(lp);
        facility.withdraw(1 ether, lp, lp);
    }

    function testFillPaysBaseAndBooksInventoryAtConfiguredNav() public {
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);

        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(facility), 100 ether, 99 ether, "");
        vm.prank(seller);
        router.executeRoute(_route(100 ether, 99 ether, legs));

        assertEq(base.balanceOf(seller), 100 ether);
        assertEq(rwa.balanceOf(address(facility)), 100 ether);
        assertEq(facility.inventoryNav(), 100 ether);
    }

    function testInventoryLotsCarryAtLowerOfAcquisitionCostAndVerifiedNav() public {
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);

        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(facility), 100 ether, 100 ether, "");
        vm.prank(seller);
        router.executeRoute(_route(100 ether, 100 ether, legs));

        assertEq(facility.inventoryNav(), 100 ether);
        facility.updateInventoryLotNav(1, 80 ether);
        assertEq(facility.inventoryNav(), 80 ether);
        facility.updateInventoryLotNav(1, 140 ether);
        assertEq(facility.inventoryNav(), 100 ether);
    }

    function testVerifiedNavRegistryBlocksOwnerMarkAndDrivesQuotes() public {
        MockNavProofRegistry navReg = new MockNavProofRegistry();
        navReg.setLatest(address(rwa), 2e18, 18, uint64(block.timestamp), uint64(block.timestamp + 1 days));
        facility.setNavProofRegistry(address(navReg));
        // Owner rwaNav is ignored once registry is configured; latest registry value wins.
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);

        assertEq(facility.quote(address(rwa), 100 ether, block.number), 200 ether);

        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(facility), 50 ether, 100 ether, "");
        vm.prank(seller);
        router.executeRoute(_route(50 ether, 100 ether, legs));
        assertEq(facility.inventoryNav(), 100 ether);

        vm.expectRevert(bytes("NAV_REGISTRY_MODE"));
        facility.updateInventoryLotNav(1, 80 ether);

        navReg.setLatest(address(rwa), 1e18, 18, uint64(block.timestamp), uint64(block.timestamp + 1 days));
        facility.refreshInventoryLotNav(1);
        assertEq(facility.inventoryNav(), 50 ether);
    }

    function testRedemptionConsumesOnlyTheSelectedInventoryLot() public {
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);

        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(facility), 100 ether, 100 ether, "");
        vm.prank(seller);
        router.executeRoute(_route(100 ether, 100 ether, legs));

        facility.setRwa(address(rwa), 2e18, true);
        rwa.mint(seller, 100 ether);
        legs[0].sellAmount = 100 ether;
        legs[0].minOutput = 100 ether;
        RFQRouter.RoutePlan memory second = _route(100 ether, 100 ether, legs);
        second.commitment = bytes32(uint256(1000));
        vm.prank(seller);
        router.executeRoute(second);

        facility.bookRedemptionFromLot(keccak256("lot-redemption"), 1, 90 ether);
        assertEq(facility.inventoryNav(), 200 ether);
        assertEq(facility.inventoryByRwa(address(rwa)), 100 ether);
    }

    function testRedemptionSettlesOnceAndRecognizesShortfall() public {
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(facility), 100 ether, 100 ether, "");
        vm.prank(seller);
        router.executeRoute(_route(100 ether, 100 ether, legs));

        bytes32 requestId = keccak256("redemption-1");
        facility.bookRedemptionFromLot(requestId, 1, 100 ether);
        base.mint(address(this), 95 ether);
        base.approve(address(facility), 95 ether);
        facility.settleRedemption(requestId, 95 ether);

        assertEq(facility.realizedLoss(), 5 ether);
        vm.expectRevert(bytes("REDEMPTION_SETTLED"));
        facility.settleRedemption(requestId, 95 ether);
    }

    function testPolicyAppliesRwaHaircutAndInventoryCap() public {
        facility.setRwaPolicy(address(rwa), 1e18, 1_000, 50 ether, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        (bool ok,) = address(facility).staticcall(
            abi.encodeWithSelector(facility.quote.selector, address(rwa), 50 ether, block.number)
        );
        assertTrue(ok);
        (bool capped,) = address(facility).staticcall(
            abi.encodeWithSelector(facility.quote.selector, address(rwa), 51 ether, block.number)
        );
        assertTrue(!capped);
    }

    function testQuoteRejectsFutureAndStaleDecisionBlocks() public {
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);

        // Pin absolute block numbers so via-ir does not re-read block.number at call sites.
        vm.roll(10);
        vm.expectRevert(bytes("QUOTE_SNAPSHOT_FUTURE"));
        facility.quote(address(rwa), 1 ether, 11);

        facility.setQuotePolicy(1);
        vm.roll(12);
        vm.expectRevert(bytes("QUOTE_SNAPSHOT_STALE"));
        facility.quote(address(rwa), 1 ether, 10);
    }

    function testRiskCapsBoundFacilityAndAdapterExposure() public {
        facility.setRiskCaps(800 ether, 500 ether, 300 ether);
        vm.expectRevert(bytes("FACILITY_CAP"));
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);

        facility.setRiskCaps(2_000 ether, 500 ether, 300 ether);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        facility.setAdapter(address(adapter), true);
        vm.expectRevert(bytes("ADAPTER_CAP"));
        facility.allocate(address(adapter), 400 ether);
        facility.allocate(address(adapter), 300 ether);
    }

    function testQueuedWithdrawalsSettleInRequestOrder() public {
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 1_000 ether);
        vm.prank(lp);
        uint256 first = facility.requestWithdraw(500 ether, lp, lp, 0);
        vm.prank(lp);
        uint256 second = facility.requestWithdraw(500 ether, lp, lp, 0);

        facility.deallocate(address(adapter), 500 ether);
        vm.expectRevert(bytes("WITHDRAWAL_ORDER"));
        facility.settleWithdraw(second);
        facility.settleWithdraw(first);
        facility.deallocate(address(adapter), 500 ether);
        facility.settleWithdraw(second);
    }

    function testWithdrawalCancellationRestoresSharesAndPreservesQueueProgress() public {
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 1_000 ether);

        vm.prank(lp);
        uint256 cancelled = facility.requestWithdraw(400 ether, lp, lp, 0);
        vm.prank(lp);
        uint256 remaining = facility.requestWithdraw(600 ether, lp, lp, 0);
        assertEq(facility.balanceOf(lp), 0);

        vm.prank(lp);
        facility.cancelWithdraw(cancelled);
        assertEq(facility.balanceOf(lp), 400 ether);
        vm.expectRevert(bytes("WITHDRAWAL_CANCELLED"));
        facility.settleWithdraw(cancelled);

        facility.deallocate(address(adapter), 600 ether);
        facility.settleWithdraw(remaining);
        assertEq(facility.totalShares(), 400 ether);
    }

    function testFillPullsDeployedAdapterLiquidity() public {
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 1_000 ether);
        assertEq(facility.idleAssets(), 0);

        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(facility), 100 ether, 100 ether, "");
        vm.prank(seller);
        router.executeRoute(_route(100 ether, 100 ether, legs));

        assertEq(base.balanceOf(seller), 100 ether);
        assertEq(facility.idleAssets(), 0);
        assertEq(adapter.totalAssets(), 900 ether);
    }

    function testTotalAssetsIncludesLiveAdapterYield() public {
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 1_000 ether);
        assertEq(facility.totalAssets(), 1_000 ether);
        adapter.accrue(100 ether);
        assertEq(adapter.totalAssets(), 1_100 ether);
        assertEq(facility.totalAssets(), 1_100 ether);
    }

    function testExecuteLiquidationRouteFundsFromShippedFacility() public {
        address recipient = address(0xFEE2);
        address venue = address(0x1111);
        address market = address(0x2222);
        bytes32 position = keccak256("facility-liq-pos");
        bytes32 policy = keccak256("facility-liq-policy");
        bytes32 issuer = keccak256("issuer");
        uint256 liquidatorRole = 8;

        FacilityMockERC20 collateral = new FacilityMockERC20();
        FacilityLiquidationAdapter liqAdapter =
            new FacilityLiquidationAdapter(base, collateral, venue, market, position);
        FacilityMockFcc fcc = new FacilityMockFcc();
        registry = new EligibilityRegistry();
        registry.setPolicy(policy, address(this), liquidatorRole, 0, type(uint64).max, issuer);

        vm.prank(lp);
        facility.deposit(200 ether, lp);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 200 ether);
        assertEq(facility.idleAssets(), 0);

        router.setEligibilityRegistry(address(registry));
        router.setFccQuorumVerifier(address(fcc));
        router.setProtocolFeeBps(50);
        router.setLiquidationFundingSource(address(facility), true);
        router.setLiquidationAdapter(address(liqAdapter), true);
        collateral.mint(address(liqAdapter), 150 ether);

        RFQRouter.LiquidationRoutePlan memory route = RFQRouter.LiquidationRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(77)),
            fccActionId: bytes32(uint256(88)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            winner: address(this),
            recipient: recipient,
            venue: venue,
            market: market,
            position: position,
            debtToken: address(base),
            collateralToken: address(collateral),
            maxRepay: 150 ether,
            minNetCollateral: 149.25 ether,
            protocolFeeBps: 50,
            fundingSource: address(facility),
            liquidationAdapter: address(liqAdapter),
            eligibilityPolicyId: policy,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: liquidatorRole,
            eligibilityIssuerReference: issuer
        });
        fcc.set(route.fccActionId, router.hashLiquidationRoute(route));

        router.executeLiquidationRoute(route);

        assertEq(base.balanceOf(address(liqAdapter)), 150 ether);
        assertEq(collateral.balanceOf(recipient), 149.25 ether);
        assertEq(adapter.totalAssets(), 50 ether);
        assertEq(facility.idleAssets(), 0);
    }

    function testFundLiquidationPullsIdleThenAdapterLiquidity() public {
        vm.prank(lp);
        facility.deposit(200 ether, lp);
        facility.setAdapter(address(adapter), true);
        facility.allocate(address(adapter), 200 ether);
        facility.setRouter(address(this));

        uint256 funded = facility.fundLiquidation(address(0xFEE1), address(base), 150 ether);
        assertEq(funded, 150 ether);
        assertEq(base.balanceOf(address(0xFEE1)), 150 ether);
        assertEq(adapter.totalAssets(), 50 ether);
    }

    function testRegistryModeSettleRedemptionRequiresMatchingReceipt() public {
        MockNavProofRegistry navReg = new MockNavProofRegistry();
        navReg.setLatest(address(rwa), 1e18, 18, uint64(block.timestamp), uint64(block.timestamp + 1 days));
        facility.setNavProofRegistry(address(navReg));
        facility.setRwa(address(rwa), 1e18, true);
        vm.prank(lp);
        facility.deposit(1_000 ether, lp);
        router.setSource(address(facility), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(facility), 100 ether, 100 ether, "");
        vm.prank(seller);
        router.executeRoute(_route(100 ether, 100 ether, legs));

        bytes32 requestId = keccak256("proof-redemption");
        facility.bookRedemptionFromLot(requestId, 1, 100 ether);
        base.mint(address(this), 100 ether);
        base.approve(address(facility), 100 ether);

        vm.expectRevert(bytes("REDEMPTION_PROOF"));
        facility.settleRedemption(requestId, 100 ether);

        navReg.setRedemptionReceipt(requestId, 95 ether, uint64(block.timestamp + 1 days));
        base.mint(address(this), 95 ether);
        base.approve(address(facility), 95 ether);
        vm.expectRevert(bytes("REDEMPTION_PROOF"));
        facility.settleRedemption(requestId, 100 ether);

        facility.settleRedemption(requestId, 95 ether);
        assertEq(facility.realizedLoss(), 5 ether);
    }

    function _route(uint256 sellAmount, uint256 minOutput, RFQRouter.Leg[] memory legs)
        private
        view
        returns (RFQRouter.RoutePlan memory)
    {
        return RFQRouter.RoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(99)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            sellToken: address(rwa),
            buyToken: address(base),
            sellAmount: sellAmount,
            minOutput: minOutput,
            legs: legs
        });
    }
}

contract FacilityLiquidationAdapter {
    FacilityMockERC20 public immutable debtToken;
    FacilityMockERC20 public immutable collateralToken;
    address public immutable expectedVenue;
    address public immutable expectedMarket;
    bytes32 public immutable expectedPosition;

    constructor(
        FacilityMockERC20 debtToken_,
        FacilityMockERC20 collateralToken_,
        address venue_,
        address market_,
        bytes32 position_
    ) {
        debtToken = debtToken_;
        collateralToken = collateralToken_;
        expectedVenue = venue_;
        expectedMarket = market_;
        expectedPosition = position_;
    }

    function liquidate(
        address venue,
        address market,
        bytes32 position,
        address debtToken_,
        address collateralToken_,
        uint256 maxRepay,
        address recipient,
        bytes calldata
    ) external returns (uint256 repaid) {
        require(
            venue == expectedVenue && market == expectedMarket && position == expectedPosition
                && debtToken_ == address(debtToken) && collateralToken_ == address(collateralToken),
            "LIQUIDATION_BINDING"
        );
        debtToken.transferFrom(msg.sender, address(this), maxRepay);
        uint256 collateralAmount = collateralToken.balanceOf(address(this));
        collateralToken.transfer(recipient, collateralAmount);
        return maxRepay;
    }
}

contract FacilityMockFcc {
    mapping(bytes32 => bytes32) public selected;

    function set(bytes32 actionId, bytes32 resultHash) external {
        selected[actionId] = resultHash;
    }

    function quorum(bytes32 actionId) external view returns (bool ready, bytes32 selectedHash) {
        selectedHash = selected[actionId];
        ready = selectedHash != bytes32(0);
    }
}

contract MockNavProofRegistry {
    struct Latest {
        uint256 value;
        uint8 decimals;
        uint64 asOf;
        uint64 validUntil;
    }

    struct Receipt {
        uint256 receivedAssets;
        uint64 validUntil;
    }

    mapping(address => Latest) private _latest;
    mapping(bytes32 => Receipt) private _receipts;

    function setLatest(address asset, uint256 value, uint8 decimals, uint64 asOf, uint64 validUntil) external {
        _latest[asset] = Latest(value, decimals, asOf, validUntil);
    }

    function setRedemptionReceipt(bytes32 requestId, uint256 receivedAssets, uint64 validUntil) external {
        _receipts[requestId] = Receipt(receivedAssets, validUntil);
    }

    function latest(address asset)
        external
        view
        returns (uint256 value, uint8 decimals, uint64 asOf, uint64 validUntil)
    {
        Latest memory row = _latest[asset];
        return (row.value, row.decimals, row.asOf, row.validUntil);
    }

    function redemptionReceipt(bytes32 requestId) external view returns (uint256 receivedAssets, uint64 validUntil) {
        Receipt memory row = _receipts[requestId];
        return (row.receivedAssets, row.validUntil);
    }
}
