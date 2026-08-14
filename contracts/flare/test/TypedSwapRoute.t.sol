// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {RFQRouter} from "../src/RFQRouter.sol";

contract MockSwapFccQuorum {
    mapping(bytes32 => bytes32) public selected;

    function set(bytes32 actionId, bytes32 resultHash) external {
        selected[actionId] = resultHash;
    }

    function quorum(bytes32 actionId) external view returns (bool ready, bytes32 selectedHash) {
        selectedHash = selected[actionId];
        ready = selectedHash != bytes32(0);
    }
}

contract TypedSwapToken {
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

contract TypedSwapSource {
    TypedSwapToken private immutable sellToken;
    TypedSwapToken private immutable buyToken;
    uint256 private immutable output;

    constructor(TypedSwapToken sellToken_, TypedSwapToken buyToken_, uint256 output_) {
        sellToken = sellToken_;
        buyToken = buyToken_;
        output = output_;
    }

    function execute(
        address seller,
        address sellToken_,
        address buyToken_,
        uint256 sellAmount,
        uint256,
        bytes calldata
    ) external returns (uint256) {
        require(sellToken_ == address(sellToken) && buyToken_ == address(buyToken), "PAIR");
        sellToken.transferFrom(seller, address(this), sellAmount);
        buyToken.transfer(msg.sender, output);
        return output;
    }
}

contract TypedSwapRouteTest is TestBase {
    address private seller = address(0xBEEF);
    address private recipient = address(0xCAFE);
    bytes32 private constant POLICY = keccak256("seller-policy");
    bytes32 private constant ISSUER = keccak256("issuer");
    uint256 private constant SELLER_ROLE = 1;

    TypedSwapToken private rwa;
    TypedSwapToken private usdx;
    TypedSwapSource private source;
    RFQRouter private router;
    EligibilityRegistry private registry;
    MockSwapFccQuorum private fcc;

    function setUp() public {
        rwa = new TypedSwapToken();
        usdx = new TypedSwapToken();
        source = new TypedSwapSource(rwa, usdx, 1_000 ether);
        router = new RFQRouter();
        registry = new EligibilityRegistry();
        fcc = new MockSwapFccQuorum();
        registry.setPolicy(POLICY, seller, SELLER_ROLE, 0, type(uint64).max, ISSUER);
        router.setSource(address(source), true);
        router.setEligibilityRegistry(address(registry));
        router.setProtocolFeeBps(50);
        router.setFccQuorumVerifier(address(fcc));
        rwa.mint(seller, 100 ether);
        usdx.mint(address(source), 1_000 ether);
        vm.prank(seller);
        rwa.approve(address(source), type(uint256).max);
    }

    function testTypedSwapBindsSellerRecipientAndChargesOneAggregateFee() public {
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(source), 100 ether, 1_000 ether, "");
        RFQRouter.SwapRoutePlan memory route = _route(100 ether, 995 ether, legs);
        fcc.set(route.fccActionId, router.hashSwapRoute(route));

        vm.prank(seller);
        router.executeSwapRoute(route);

        assertEq(rwa.balanceOf(seller), 0);
        assertEq(usdx.balanceOf(recipient), 995 ether);
        assertEq(usdx.balanceOf(address(router)), 0);
        assertEq(usdx.balanceOf(address(this)), 5 ether);
    }

    function testTypedSwapRejectsWrongCallerAndStaleEligibilityEpoch() public {
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(source), 100 ether, 1_000 ether, "");
        RFQRouter.SwapRoutePlan memory route = _route(100 ether, 995 ether, legs);

        vm.expectRevert(bytes("SELLER_BINDING"));
        vm.prank(address(0x1234));
        router.executeSwapRoute(route);

        registry.revoke(POLICY);
        vm.expectRevert(bytes("NOT_ELIGIBLE"));
        vm.prank(seller);
        router.executeSwapRoute(route);
    }

    function testTypedSwapRejectsFeeMismatchAndGrossMinimumBelowNetMinimum() public {
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(source), 100 ether, 1_000 ether, "");
        RFQRouter.SwapRoutePlan memory route = _route(100 ether, 995 ether, legs);
        route.protocolFeeBps = 0;

        vm.expectRevert(bytes("FEE_MISMATCH"));
        vm.prank(seller);
        router.executeSwapRoute(route);

        route.protocolFeeBps = 50;
        route.minOutput = 996 ether;
        fcc.set(route.fccActionId, router.hashSwapRoute(route));
        vm.expectRevert(bytes("MIN_OUTPUT"));
        vm.prank(seller);
        router.executeSwapRoute(route);
    }

    function testTypedSwapRequiresExactFccQuorum() public {
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(source), 100 ether, 1_000 ether, "");
        RFQRouter.SwapRoutePlan memory route = _route(100 ether, 995 ether, legs);

        vm.expectRevert(bytes("FCC_QUORUM_UNAVAILABLE"));
        vm.prank(seller);
        router.executeSwapRoute(route);

        fcc.set(route.fccActionId, keccak256("different-route"));
        vm.expectRevert(bytes("FCC_RESULT_MISMATCH"));
        vm.prank(seller);
        router.executeSwapRoute(route);
    }

    function _route(uint256 sellAmount, uint256 minOutput, RFQRouter.Leg[] memory legs)
        private
        view
        returns (RFQRouter.SwapRoutePlan memory)
    {
        return RFQRouter.SwapRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(7)),
            fccActionId: bytes32(uint256(8)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            seller: seller,
            recipient: recipient,
            sellToken: address(rwa),
            buyToken: address(usdx),
            sellAmount: sellAmount,
            minOutput: minOutput,
            protocolFeeBps: 50,
            eligibilityPolicyId: POLICY,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: SELLER_ROLE,
            eligibilityIssuerReference: ISSUER,
            legs: legs
        });
    }
}
