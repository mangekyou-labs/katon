// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {RFQRouter} from "../src/RFQRouter.sol";
import {MorphoLiquidationAdapter} from "../src/adapters/MorphoLiquidationAdapter.sol";
import {KineticLiquidationAdapter} from "../src/adapters/KineticLiquidationAdapter.sol";
import {MockLendingMarket} from "../src/adapters/mocks/MockLendingMarket.sol";
import {
    MockKineticComptroller,
    MockKineticLiquidationMarket
} from "../src/adapters/mocks/MockKineticLiquidationMarket.sol";

contract MockLiquidationFccQuorum {
    mapping(bytes32 => bytes32) public selected;

    function set(bytes32 actionId, bytes32 resultHash) external {
        selected[actionId] = resultHash;
    }

    function quorum(bytes32 actionId) external view returns (bool ready, bytes32 selectedHash) {
        selectedHash = selected[actionId];
        ready = selectedHash != bytes32(0);
    }
}

contract LiquidationToken {
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

contract MockLiquidationFundingSource {
    LiquidationToken public immutable debtToken;
    uint256 public immutable amount;

    constructor(LiquidationToken debtToken_, uint256 amount_) {
        debtToken = debtToken_;
        amount = amount_;
    }

    function fund(address recipient, address expectedDebtToken, uint256 requested) external returns (uint256) {
        require(expectedDebtToken == address(debtToken) && requested == amount, "FUNDING_BINDING");
        debtToken.transfer(recipient, amount);
        return amount;
    }
}

contract MockLiquidationAdapter {
    LiquidationToken public immutable debtToken;
    LiquidationToken public immutable collateralToken;
    address public immutable expectedVenue;
    address public immutable expectedMarket;
    bytes32 public immutable expectedPosition;
    uint256 public immutable collateralAmount;
    bool public shouldRevert;

    constructor(
        LiquidationToken debtToken_,
        LiquidationToken collateralToken_,
        address venue_,
        address market_,
        bytes32 position_,
        uint256 collateralAmount_
    ) {
        debtToken = debtToken_;
        collateralToken = collateralToken_;
        expectedVenue = venue_;
        expectedMarket = market_;
        expectedPosition = position_;
        collateralAmount = collateralAmount_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
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
        require(!shouldRevert, "VENUE_FAILED");
        require(
            venue == expectedVenue && market == expectedMarket && position == expectedPosition
                && debtToken_ == address(debtToken) && collateralToken_ == address(collateralToken),
            "LIQUIDATION_BINDING"
        );
        debtToken.transferFrom(msg.sender, address(this), maxRepay);
        collateralToken.transfer(recipient, collateralAmount);
        return maxRepay;
    }
}

contract TypedLiquidationRouteTest is TestBase {
    address private recipient = address(0xCAFE);
    bytes32 private constant POLICY = keccak256("liquidator-policy");
    bytes32 private constant ISSUER = keccak256("issuer");
    bytes32 private constant POSITION = keccak256("position-1");
    address private constant KINETIC_BORROWER = address(0xB0B);
    bytes32 private constant KINETIC_POSITION = bytes32(uint256(uint160(KINETIC_BORROWER)));
    uint256 private constant LIQUIDATOR_ROLE = 8;
    address private constant VENUE = address(0x1111);
    address private constant MARKET = address(0x2222);

    LiquidationToken private debt;
    LiquidationToken private collateral;
    MockLiquidationFundingSource private funding;
    MockLiquidationAdapter private adapter;
    RFQRouter private router;
    EligibilityRegistry private registry;
    MockLiquidationFccQuorum private fcc;

    function setUp() public {
        debt = new LiquidationToken();
        collateral = new LiquidationToken();
        funding = new MockLiquidationFundingSource(debt, 100 ether);
        adapter = new MockLiquidationAdapter(debt, collateral, VENUE, MARKET, POSITION, 150 ether);
        router = new RFQRouter();
        registry = new EligibilityRegistry();
        fcc = new MockLiquidationFccQuorum();
        registry.setPolicy(POLICY, address(this), LIQUIDATOR_ROLE, 0, type(uint64).max, ISSUER);
        router.setEligibilityRegistry(address(registry));
        router.setProtocolFeeBps(50);
        router.setFccQuorumVerifier(address(fcc));
        router.setLiquidationFundingSource(address(funding), true);
        router.setLiquidationAdapter(address(adapter), true);
        debt.mint(address(funding), 100 ether);
        collateral.mint(address(adapter), 150 ether);
    }

    function testLiquidationRouteRepaysBoundPositionAndPaysNetCollateral() public {
        RFQRouter.LiquidationRoutePlan memory route = _route(149.25 ether);
        fcc.set(route.fccActionId, router.hashLiquidationRoute(route));
        router.executeLiquidationRoute(route);

        assertEq(debt.balanceOf(address(funding)), 0);
        assertEq(collateral.balanceOf(recipient), 149.25 ether);
        assertEq(collateral.balanceOf(address(this)), 0.75 ether);
    }

    function testLiquidationRouteRollsBackWhenAdapterFails() public {
        adapter.setShouldRevert(true);
        RFQRouter.LiquidationRoutePlan memory route = _route(149 ether);
        fcc.set(route.fccActionId, router.hashLiquidationRoute(route));

        vm.expectRevert(bytes("LIQUIDATION_CALL_FAILED"));
        router.executeLiquidationRoute(route);

        assertEq(debt.balanceOf(address(funding)), 100 ether);
        assertEq(collateral.balanceOf(address(adapter)), 150 ether);
    }

    function testLiquidationRouteRequiresExactFccQuorum() public {
        RFQRouter.LiquidationRoutePlan memory route = _route(149 ether);
        vm.expectRevert(bytes("FCC_QUORUM_UNAVAILABLE"));
        router.executeLiquidationRoute(route);

        fcc.set(route.fccActionId, keccak256("different-route"));
        vm.expectRevert(bytes("FCC_RESULT_MISMATCH"));
        router.executeLiquidationRoute(route);
    }

    function testLiquidationRouteRejectsWrongWinnerAndBindingMismatch() public {
        RFQRouter.LiquidationRoutePlan memory route = _route(149 ether);
        route.winner = address(0x1234);

        vm.expectRevert(bytes("WINNER_BINDING"));
        router.executeLiquidationRoute(route);

        route.winner = address(this);
        route.market = address(0x3333);
        fcc.set(route.fccActionId, router.hashLiquidationRoute(route));
        vm.expectRevert(bytes("LIQUIDATION_CALL_FAILED"));
        router.executeLiquidationRoute(route);
    }

    function testLiquidationRouteUsesShippedMorphoAdapter() public {
        MockLendingMarket market = new MockLendingMarket(address(debt), address(collateral));
        market.configurePosition(POSITION, 100 ether, 150 ether, 9_000, 10_000);
        MorphoLiquidationAdapter morpho = new MorphoLiquidationAdapter(
            VENUE,
            address(market),
            POSITION,
            address(debt),
            address(collateral),
            address(market)
        );
        router.setLiquidationAdapter(address(morpho), true);
        debt.mint(address(funding), 0); // funding already has 100 ether from setUp
        collateral.mint(address(market), 150 ether);

        RFQRouter.LiquidationRoutePlan memory route = RFQRouter.LiquidationRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(11)),
            fccActionId: bytes32(uint256(12)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            winner: address(this),
            recipient: recipient,
            venue: VENUE,
            market: address(market),
            position: POSITION,
            debtToken: address(debt),
            collateralToken: address(collateral),
            maxRepay: 100 ether,
            minNetCollateral: 149.25 ether,
            protocolFeeBps: 50,
            fundingSource: address(funding),
            liquidationAdapter: address(morpho),
            eligibilityPolicyId: POLICY,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: LIQUIDATOR_ROLE,
            eligibilityIssuerReference: ISSUER
        });
        fcc.set(route.fccActionId, router.hashLiquidationRoute(route));
        router.executeLiquidationRoute(route);

        assertEq(collateral.balanceOf(recipient), 149.25 ether);
        assertEq(debt.balanceOf(address(funding)), 0);
    }

    function testLiquidationRouteUsesShippedKineticAdapter() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(debt), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(collateral), address(comptroller));
        comptroller.setAccountLiquidity(KINETIC_BORROWER, 0, 0, 1 ether);
        comptroller.setCloseFactorMantissa(1e18);
        market.setBorrowBalance(KINETIC_BORROWER, 100 ether);
        market.setSeizeTokens(150 ether);
        collateralMarket.mintCollateral(KINETIC_BORROWER, 150 ether);
        collateral.mint(address(collateralMarket), 150 ether);
        KineticLiquidationAdapter kinetic = new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(debt),
            address(collateral),
            address(collateralMarket)
        );
        router.setLiquidationAdapter(address(kinetic), true);

        RFQRouter.LiquidationRoutePlan memory route = RFQRouter.LiquidationRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(13)),
            fccActionId: bytes32(uint256(14)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            winner: address(this),
            recipient: recipient,
            venue: address(comptroller),
            market: address(market),
            position: KINETIC_POSITION,
            debtToken: address(debt),
            collateralToken: address(collateral),
            maxRepay: 100 ether,
            minNetCollateral: 149.25 ether,
            protocolFeeBps: 50,
            fundingSource: address(funding),
            liquidationAdapter: address(kinetic),
            eligibilityPolicyId: POLICY,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: LIQUIDATOR_ROLE,
            eligibilityIssuerReference: ISSUER
        });
        fcc.set(route.fccActionId, router.hashLiquidationRoute(route));
        router.executeLiquidationRoute(route);

        assertEq(collateral.balanceOf(recipient), 149.25 ether);
        assertEq(collateral.balanceOf(address(this)), 0.75 ether);
        assertEq(debt.balanceOf(address(funding)), 0);
    }

    function _route(uint256 minOutput) private view returns (RFQRouter.LiquidationRoutePlan memory) {
        return RFQRouter.LiquidationRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(9)),
            fccActionId: bytes32(uint256(10)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            winner: address(this),
            recipient: recipient,
            venue: VENUE,
            market: MARKET,
            position: POSITION,
            debtToken: address(debt),
            collateralToken: address(collateral),
            maxRepay: 100 ether,
            minNetCollateral: minOutput,
            protocolFeeBps: 50,
            fundingSource: address(funding),
            liquidationAdapter: address(adapter),
            eligibilityPolicyId: POLICY,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: LIQUIDATOR_ROLE,
            eligibilityIssuerReference: ISSUER
        });
    }
}
