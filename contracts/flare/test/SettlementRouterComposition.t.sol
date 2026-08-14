// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {RFQRouter} from "../src/RFQRouter.sol";
import {RFQSettlement} from "../src/RFQSettlement.sol";

contract MockCompositionFccQuorum {
    mapping(bytes32 => bytes32) public selected;

    function set(bytes32 actionId, bytes32 resultHash) external {
        selected[actionId] = resultHash;
    }

    function quorum(bytes32 actionId) external view returns (bool ready, bytes32 selectedHash) {
        selectedHash = selected[actionId];
        ready = selectedHash != bytes32(0);
    }
}

contract CompositionToken {
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

contract SettlementRouterCompositionTest is TestBase {
    uint256 private constant MAKER_PK = 0xA11CE;
    address private constant SELLER = address(0xBEEF);
    bytes32 private constant POLICY = keccak256("seller-policy");
    bytes32 private constant ISSUER = keccak256("issuer");

    CompositionToken private rwa;
    CompositionToken private usdx;
    RFQSettlement private settlement;
    RFQRouter private router;
    MockCompositionFccQuorum private fcc;
    EligibilityRegistry private registry;
    address private maker;

    function setUp() public {
        maker = vm.addr(MAKER_PK);
        rwa = new CompositionToken();
        usdx = new CompositionToken();
        settlement = new RFQSettlement();
        router = new RFQRouter();
        fcc = new MockCompositionFccQuorum();
        registry = new EligibilityRegistry();
        registry.setPolicy(POLICY, SELLER, 1, 0, type(uint64).max, ISSUER);

        settlement.setRouter(address(router));
        router.setSource(address(settlement), true);
        router.setEligibilityRegistry(address(registry));
        router.setProtocolFeeBps(50);
        router.setFccQuorumVerifier(address(fcc));

        usdx.mint(maker, 1_000 ether);
        rwa.mint(SELLER, 100 ether);
        vm.prank(maker);
        usdx.approve(address(settlement), type(uint256).max);
        vm.prank(SELLER);
        rwa.approve(address(settlement), type(uint256).max);
    }

    function testTypedRouteComposesSettlementAndChargesOnlyRouterFee() public {
        RFQSettlement.Order memory order = RFQSettlement.Order({
            maker: maker,
            taker: SELLER,
            executor: address(router),
            sellToken: address(usdx),
            buyToken: address(rwa),
            sellAmount: 1_000 ether,
            minBuyAmount: 100 ether,
            expiry: block.timestamp + 1 hours,
            nonce: 1,
            pairSalt: bytes32(uint256(1)),
            contextCommitment: bytes32(uint256(11)),
            orderType: 0,
            fillMode: 1,
            feeBps: 50
        });
        bytes memory signature = _sign(order);
        RFQSettlement.RouteFill memory routeFill = RFQSettlement.RouteFill({
            order: order,
            orderSellAmount: 1_000 ether,
            orderBuyAmount: 100 ether,
            signature: signature
        });
        bytes memory sourceData = abi.encode(routeFill);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(settlement), 100 ether, 1_000 ether, sourceData);
        RFQRouter.SwapRoutePlan memory route = RFQRouter.SwapRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(11)),
            fccActionId: bytes32(uint256(12)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            seller: SELLER,
            recipient: SELLER,
            sellToken: address(rwa),
            buyToken: address(usdx),
            sellAmount: 100 ether,
            minOutput: 995 ether,
            protocolFeeBps: 50,
            eligibilityPolicyId: POLICY,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: 1,
            eligibilityIssuerReference: ISSUER,
            legs: legs
        });
        fcc.set(route.fccActionId, router.hashSwapRoute(route));

        vm.prank(SELLER);
        router.executeSwapRoute(route);

        require(rwa.balanceOf(SELLER) == 0, "SELLER_RWA");
        require(usdx.balanceOf(SELLER) == 995 ether, "SELLER_USDX");
        require(usdx.balanceOf(address(this)) == 5 ether, "FEE_USDX");
        require(usdx.balanceOf(maker) == 0, "MAKER_USDX");
        require(rwa.balanceOf(maker) == 100 ether, "MAKER_RWA");
    }

    /// @dev Public standing (taker==0, orderType=1) must be blendable as an executeSwapRoute leg.
    function testOpenTakerStandingOrderIsExecutableAsRouteLeg() public {
        RFQSettlement.Order memory order = RFQSettlement.Order({
            maker: maker,
            taker: address(0),
            executor: address(0),
            sellToken: address(usdx),
            buyToken: address(rwa),
            sellAmount: 1_000 ether,
            minBuyAmount: 100 ether,
            expiry: block.timestamp + 1 hours,
            nonce: 2,
            pairSalt: bytes32(uint256(2)),
            contextCommitment: bytes32(0),
            orderType: 1,
            fillMode: 1,
            feeBps: 50
        });
        bytes memory signature = _sign(order);
        RFQSettlement.RouteFill memory routeFill = RFQSettlement.RouteFill({
            order: order,
            orderSellAmount: 1_000 ether,
            orderBuyAmount: 100 ether,
            signature: signature
        });
        bytes memory sourceData = abi.encode(routeFill);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(settlement), 100 ether, 1_000 ether, sourceData);
        RFQRouter.SwapRoutePlan memory route = RFQRouter.SwapRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(21)),
            fccActionId: bytes32(uint256(22)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            seller: SELLER,
            recipient: SELLER,
            sellToken: address(rwa),
            buyToken: address(usdx),
            sellAmount: 100 ether,
            minOutput: 995 ether,
            protocolFeeBps: 50,
            eligibilityPolicyId: POLICY,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: 1,
            eligibilityIssuerReference: ISSUER,
            legs: legs
        });
        fcc.set(route.fccActionId, router.hashSwapRoute(route));

        vm.prank(SELLER);
        router.executeSwapRoute(route);

        require(rwa.balanceOf(SELLER) == 0, "SELLER_RWA");
        require(usdx.balanceOf(SELLER) == 995 ether, "SELLER_USDX");
        require(usdx.balanceOf(address(this)) == 5 ether, "FEE_USDX");
        require(rwa.balanceOf(maker) == 100 ether, "MAKER_RWA");
    }

    function _sign(RFQSettlement.Order memory order) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, settlement.orderDigest(order));
        return abi.encodePacked(r, s, v);
    }
}
