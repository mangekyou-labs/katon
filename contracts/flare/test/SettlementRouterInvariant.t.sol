// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {RFQSettlement} from "../src/RFQSettlement.sol";
import {RFQRouter} from "../src/RFQRouter.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {MockERC20, MockERC1271Wallet} from "./RFQSettlement.t.sol";
import {TypedSwapToken, TypedSwapSource, MockSwapFccQuorum} from "./TypedSwapRoute.t.sol";

contract ReentrantFillToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    RFQSettlement public settlement;
    RFQSettlement.Order public order;
    bytes public signature;
    bytes32 public policyId;
    bytes32 public issuerReference;
    bool public armed;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm(
        RFQSettlement settlement_,
        RFQSettlement.Order memory order_,
        bytes memory signature_,
        bytes32 policyId_,
        bytes32 issuerReference_
    ) external {
        settlement = settlement_;
        order = order_;
        signature = signature_;
        policyId = policyId_;
        issuerReference = issuerReference_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (armed) {
            armed = false;
            settlement.fillWithEligibility(order, amount, amount * 2_000, signature, policyId, 0, 1, issuerReference);
        }
        return true;
    }
}

contract RevertingErc1271Wallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert("WALLET_REVERT");
    }
}

contract SettlementRouterInvariantTest is TestBase {
    uint256 private constant MAKER_PK = 0xA11CE;
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant TAKER_POLICY = keccak256("taker-policy");
    bytes32 private constant ISSUER_REFERENCE = keccak256("issuer");

    address private maker;
    address private taker;
    MockERC20 private rwa;
    MockERC20 private usdx;
    RFQSettlement private settlement;
    EligibilityRegistry private registry;

    function setUp() public {
        maker = vm.addr(MAKER_PK);
        taker = vm.addr(0xB0B);
        rwa = new MockERC20("Permissioned RWA");
        usdx = new MockERC20("USDX");
        settlement = new RFQSettlement();
        registry = new EligibilityRegistry();
        registry.setPolicy(TAKER_POLICY, taker, 1, 0, type(uint64).max, ISSUER_REFERENCE);
        settlement.setEligibilityRegistry(address(registry));
        rwa.mint(maker, 1_000 ether);
        usdx.mint(taker, 2_000_000 ether);
        vm.prank(maker);
        rwa.approve(address(settlement), type(uint256).max);
        vm.prank(taker);
        usdx.approve(address(settlement), type(uint256).max);
    }

    function testRemainingFillableTracksPartialAndFullFills() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);

        assertEq(settlement.remainingFillable(order), 10 ether);

        vm.prank(taker);
        _fillEligible(order, 4 ether, 8_000 ether, signature);
        assertEq(settlement.remainingFillable(order), 6 ether);
        assertEq(settlement.filled(settlement.orderDigest(order)) + settlement.remainingFillable(order), order.sellAmount);

        vm.prank(taker);
        _fillEligible(order, 6 ether, 12_000 ether, signature);
        assertEq(settlement.remainingFillable(order), 0);
        assertEq(settlement.filled(settlement.orderDigest(order)), 10 ether);
    }

    function testRemainingFillableIsZeroAfterCancel() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        vm.prank(maker);
        settlement.cancel(order);
        assertEq(settlement.remainingFillable(order), 0);
    }

    function testFuzzRemainingConservedAcrossPartialFills(uint96 firstSeed, uint96 secondSeed) public {
        uint256 signedAmount = 10 ether;
        uint256 firstAmount = bound(uint256(firstSeed), 1, signedAmount - 1);
        uint256 secondAmount = bound(uint256(secondSeed), 1, signedAmount - firstAmount);
        RFQSettlement.Order memory order = _order(signedAmount, 20_000 ether);
        bytes memory signature = _sign(order);

        assertEq(settlement.remainingFillable(order), signedAmount);

        vm.prank(taker);
        _fillEligible(order, firstAmount, firstAmount * 2_000, signature);
        assertEq(settlement.remainingFillable(order), signedAmount - firstAmount);

        vm.prank(taker);
        _fillEligible(order, secondAmount, secondAmount * 2_000, signature);
        uint256 remaining = settlement.remainingFillable(order);
        assertEq(settlement.filled(settlement.orderDigest(order)) + remaining, signedAmount);
        assertTrue(remaining == signedAmount - firstAmount - secondAmount);
    }

    function testExecuteConfidentialFillConsumesRemaining() public {
        RFQRouter feeView = new RFQRouter();
        feeView.setProtocolFeeBps(25);
        settlement.setRouter(address(feeView));

        RFQSettlement.Order memory order = RFQSettlement.Order({
            maker: maker,
            taker: taker,
            executor: address(feeView),
            sellToken: address(rwa),
            buyToken: address(usdx),
            sellAmount: 10 ether,
            minBuyAmount: 20_000 ether,
            expiry: block.timestamp + 1 days,
            nonce: 9,
            pairSalt: bytes32(uint256(99)),
            contextCommitment: bytes32(uint256(0xabc)),
            orderType: 0,
            fillMode: 0,
            feeBps: 25
        });
        bytes memory signature = _sign(order);
        RFQSettlement.RouteFill memory routeFill = RFQSettlement.RouteFill({
            order: order,
            orderSellAmount: 10 ether,
            orderBuyAmount: 20_000 ether,
            signature: signature
        });

        assertEq(settlement.remainingFillable(order), 10 ether);
        vm.prank(address(feeView));
        settlement.execute(taker, address(usdx), address(rwa), 20_000 ether, 10 ether, abi.encode(routeFill));
        assertEq(settlement.remainingFillable(order), 0);
    }

    function testRejectsHighSSignatureAndLeavesRemainingIntact() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        s = bytes32(SECP256K1N_HALF + 1);
        bytes memory highS = abi.encodePacked(r, s, v);

        vm.expectRevert(bytes("INVALID_SIGNATURE"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, highS);
        assertEq(settlement.remainingFillable(order), 10 ether);
        assertEq(settlement.filled(settlement.orderDigest(order)), 0);
    }

    function testRejectsReentrantTokenDuringFill() public {
        ReentrantFillToken token = new ReentrantFillToken();
        token.mint(maker, 10 ether);
        vm.prank(maker);
        token.approve(address(settlement), type(uint256).max);

        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.sellToken = address(token);
        bytes memory signature = _sign(order);
        token.arm(settlement, order, signature, TAKER_POLICY, ISSUER_REFERENCE);

        // Inner fill hits nonReentrant; the token.call wrapper surfaces TOKEN_TRANSFER_FAILED.
        vm.expectRevert(bytes("TOKEN_TRANSFER_FAILED"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);
        assertEq(settlement.remainingFillable(order), 10 ether);
        assertEq(settlement.filled(settlement.orderDigest(order)), 0);
    }

    function testRejectsRevertingErc1271Wallet() public {
        RevertingErc1271Wallet wallet = new RevertingErc1271Wallet();
        rwa.mint(address(wallet), 10 ether);

        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.maker = address(wallet);

        vm.expectRevert(bytes("INVALID_SIGNATURE"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, "");
        assertEq(settlement.remainingFillable(order), 10 ether);
    }

    function testWrongExecutorDoesNotConsumeRemaining() public {
        RFQRouter boundRouter = new RFQRouter();
        RFQRouter otherRouter = new RFQRouter();
        settlement.setRouter(address(boundRouter));

        RFQSettlement.Order memory order = RFQSettlement.Order({
            maker: maker,
            taker: taker,
            executor: address(boundRouter),
            sellToken: address(rwa),
            buyToken: address(usdx),
            sellAmount: 10 ether,
            minBuyAmount: 20_000 ether,
            expiry: block.timestamp + 1 days,
            nonce: 11,
            pairSalt: bytes32(uint256(11)),
            contextCommitment: bytes32(uint256(0x11)),
            orderType: 0,
            fillMode: 0,
            feeBps: 0
        });
        bytes memory signature = _sign(order);
        RFQSettlement.RouteFill memory routeFill = RFQSettlement.RouteFill({
            order: order,
            orderSellAmount: 10 ether,
            orderBuyAmount: 20_000 ether,
            signature: signature
        });

        vm.expectRevert(bytes("EXECUTE_AUTH"));
        vm.prank(address(otherRouter));
        settlement.execute(taker, address(usdx), address(rwa), 20_000 ether, 10 ether, abi.encode(routeFill));
        assertEq(settlement.remainingFillable(order), 10 ether);
    }

    function testProtocolFeeOnMatchesChargedSwapFee() public {
        address seller = address(0xBEEF);
        address recipient = address(0xCAFE);
        TypedSwapToken sell = new TypedSwapToken();
        TypedSwapToken buy = new TypedSwapToken();
        TypedSwapSource source = new TypedSwapSource(sell, buy, 1_000 ether);
        RFQRouter router = new RFQRouter();
        EligibilityRegistry sellerRegistry = new EligibilityRegistry();
        MockSwapFccQuorum fcc = new MockSwapFccQuorum();
        bytes32 policy = keccak256("seller-policy");
        bytes32 issuer = keccak256("issuer");
        sellerRegistry.setPolicy(policy, seller, 1, 0, type(uint64).max, issuer);
        router.setSource(address(source), true);
        router.setEligibilityRegistry(address(sellerRegistry));
        router.setProtocolFeeBps(50);
        router.setFccQuorumVerifier(address(fcc));
        sell.mint(seller, 100 ether);
        buy.mint(address(source), 1_000 ether);
        vm.prank(seller);
        sell.approve(address(source), type(uint256).max);

        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(source), 100 ether, 1_000 ether, "");
        RFQRouter.SwapRoutePlan memory route = RFQRouter.SwapRoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(7)),
            fccActionId: bytes32(uint256(8)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            seller: seller,
            recipient: recipient,
            sellToken: address(sell),
            buyToken: address(buy),
            sellAmount: 100 ether,
            minOutput: 995 ether,
            protocolFeeBps: 50,
            eligibilityPolicyId: policy,
            eligibilityRevocationEpoch: 0,
            eligibilityRole: 1,
            eligibilityIssuerReference: issuer,
            legs: legs
        });
        fcc.set(route.fccActionId, router.hashSwapRoute(route));

        assertEq(router.protocolFeeOn(1_000 ether), 5 ether);

        vm.prank(seller);
        router.executeSwapRoute(route);

        assertEq(buy.balanceOf(address(this)), router.protocolFeeOn(1_000 ether));
        assertEq(buy.balanceOf(recipient) + buy.balanceOf(address(this)), 1_000 ether);
    }

    function _fillEligible(
        RFQSettlement.Order memory order,
        uint256 sellAmount,
        uint256 buyAmount,
        bytes memory signature
    ) private {
        settlement.fillWithEligibility(
            order, sellAmount, buyAmount, signature, TAKER_POLICY, 0, 1, ISSUER_REFERENCE
        );
    }

    function _order(uint256 amount, uint256 minimum) private view returns (RFQSettlement.Order memory) {
        return RFQSettlement.Order({
            maker: maker,
            taker: taker,
            executor: address(0),
            sellToken: address(rwa),
            buyToken: address(usdx),
            sellAmount: amount,
            minBuyAmount: minimum,
            expiry: block.timestamp + 1 days,
            nonce: 7,
            pairSalt: bytes32(uint256(42)),
            contextCommitment: bytes32(0),
            orderType: 1,
            fillMode: 0,
            feeBps: 0
        });
    }

    function _sign(RFQSettlement.Order memory order) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, settlement.orderDigest(order));
        return abi.encodePacked(r, s, v);
    }
}
