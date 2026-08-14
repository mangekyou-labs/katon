// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {RFQSettlement} from "../src/RFQSettlement.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";

contract MockERC20 {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory tokenName) {
        name = tokenName;
    }

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
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "ALLOWANCE");
        allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FalseTransferToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract FeeTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - (amount / 100);
        return true;
    }
}

contract MockERC1271Wallet {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;
    bytes32 private validHash;

    function setValidHash(bytes32 hash) external {
        validHash = hash;
    }

    function approveToken(MockERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return hash == validHash ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}

contract RFQSettlementTest is TestBase {
    uint256 private constant MAKER_PK = 0xA11CE;
    uint256 private constant DELEGATE_PK = 0xD1E6A;
    address private maker;
    address private taker;
    MockERC20 private rwa;
    MockERC20 private usdx;
    RFQSettlement private settlement;
    EligibilityRegistry private registry;
    bytes32 private constant TAKER_POLICY = keccak256("taker-policy");
    bytes32 private constant ISSUER_REFERENCE = keccak256("issuer");

    function setUp() public {
        maker = vm.addr(MAKER_PK);
        taker = vm.addr(0xB0B);
        rwa = new MockERC20("Permissioned RWA");
        usdx = new MockERC20("USDX");
        settlement = new RFQSettlement();
        registry = new EligibilityRegistry();
        registry.setPolicy(TAKER_POLICY, taker, 1, 0, type(uint64).max, ISSUER_REFERENCE);
        settlement.setEligibilityRegistry(address(registry));
        rwa.mint(maker, 100 ether);
        usdx.mint(taker, 100_000 ether);
        vm.prank(maker);
        rwa.approve(address(settlement), type(uint256).max);
        vm.prank(taker);
        usdx.approve(address(settlement), type(uint256).max);
    }

    function testPlainFillRequiresEligibility() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);
        vm.expectRevert(bytes("ELIGIBILITY_REQUIRED"));
        vm.prank(taker);
        settlement.fill(order, 10 ether, 20_000 ether, signature);
    }

    function testFillTransfersBothLegsAndPreventsReplay() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);

        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);

        assertEq(rwa.balanceOf(taker), 10 ether);
        assertEq(usdx.balanceOf(maker), 20_000 ether);
        assertEq(settlement.filled(orderDigest(order)), 10 ether);

        vm.expectRevert(bytes("ORDER_ALREADY_FILLED"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);
    }

    function testFillWithEligibilityRequiresCurrentTakerPolicy() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);

        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);
        assertEq(rwa.balanceOf(taker), 10 ether);

        RFQSettlement.Order memory second = _order(1 ether, 2_000 ether);
        second.nonce = 8;
        bytes memory secondSignature = _sign(second);
        registry.revoke(TAKER_POLICY);
        vm.expectRevert(bytes("NOT_ELIGIBLE"));
        vm.prank(taker);
        _fillEligible(second, 1 ether, 2_000 ether, secondSignature);
    }

    function testRejectsBuyAmountBelowSignedMinimum() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);
        vm.expectRevert(bytes("MIN_OUTPUT"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 19_999 ether, signature);
    }

    function testOrderDigestUsesCanonicalEip712Encoding() public {
        vm.chainId(114);
        RFQSettlement canonicalSettlement = new RFQSettlement();
        RFQSettlement.Order memory order = RFQSettlement.Order({
            maker: address(1),
            taker: address(2),
            executor: address(0xbb),
            sellToken: address(0x10),
            buyToken: address(0x20),
            sellAmount: 1 ether,
            minBuyAmount: 950_000_000_000_000_000,
            expiry: 2_000_000_000,
            nonce: 7,
            pairSalt: bytes32(uint256(0x42)),
            contextCommitment: bytes32(uint256(0x43)),
            orderType: 0,
            fillMode: 0,
            feeBps: 0
        });

        bytes32 orderTypeHash = keccak256(
            bytes(
                "Order(address maker,address taker,address executor,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint64 expiry,uint256 nonce,bytes32 pairSalt,bytes32 contextCommitment,uint8 orderType,uint8 fillMode,uint16 feeBps)"
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                orderTypeHash,
                order.maker,
                order.taker,
                order.executor,
                order.sellToken,
                order.buyToken,
                order.sellAmount,
                order.minBuyAmount,
                order.expiry,
                order.nonce,
                order.pairSalt,
                order.contextCommitment,
                order.orderType,
                order.fillMode,
                order.feeBps
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
                keccak256(bytes("TrustRFQ")),
                keccak256(bytes("1")),
                uint256(114),
                address(canonicalSettlement)
            )
        );

        assertEq(canonicalSettlement.ORDER_TYPEHASH(), orderTypeHash);
        assertEq(canonicalSettlement.DOMAIN_SEPARATOR(), domainSeparator);
        bytes32 digest = canonicalSettlement.orderDigest(order);
        assertEq(digest, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }

    function testConfidentialOrderRequiresTakerExecutorAndContext() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.orderType = 0;
        order.executor = address(0);
        order.contextCommitment = bytes32(0);
        bytes memory signature = _sign(order);
        // fillWithEligibility allows executor=0, then confidential validation requires executor.
        vm.expectRevert(bytes("EXECUTOR_REQUIRED"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);

        order.executor = address(0xBEEF);
        order.contextCommitment = bytes32(uint256(1));
        signature = _sign(order);
        // Direct eligible fill still blocks nonzero executor at the entry gate.
        vm.expectRevert(bytes("EXECUTOR_RESTRICTED"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);
    }

    function testConfidentialExecuteBindsExecutorAndFeeCap() public {
        // Router with fee above signed cap reverts FEE_CAP.
        HighFeeRouter highFee = new HighFeeRouter(50);
        settlement.setRouter(address(highFee));

        RFQSettlement.Order memory order = RFQSettlement.Order({
            maker: maker,
            taker: taker,
            executor: address(highFee),
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
        vm.expectRevert(bytes("FEE_CAP"));
        vm.prank(address(highFee));
        settlement.execute(taker, address(usdx), address(rwa), 20_000 ether, 10 ether, abi.encode(routeFill));

        // Matching fee succeeds.
        HighFeeRouter okFee = new HighFeeRouter(25);
        settlement.setRouter(address(okFee));
        order.executor = address(okFee);
        signature = _sign(order);
        routeFill.order = order;
        routeFill.signature = signature;
        vm.prank(address(okFee));
        uint256 out = settlement.execute(
            taker, address(usdx), address(rwa), 20_000 ether, 10 ether, abi.encode(routeFill)
        );
        assertEq(out, 10 ether);
        assertEq(rwa.balanceOf(address(okFee)), 10 ether);
    }

    function testRejectsExpiryOutsideCanonicalUint64() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.expiry = uint256(type(uint64).max) + 1;

        vm.expectRevert(bytes("EXPIRY_WIDTH"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, "");
    }

    function testFalseReturningTokenRollsBackFillState() public {
        FalseTransferToken falseToken = new FalseTransferToken();
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.buyToken = address(falseToken);
        bytes memory signature = _sign(order);

        vm.expectRevert(bytes("TOKEN_TRANSFER_FAILED"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);

        assertEq(settlement.filled(orderDigest(order)), 0);
        assertEq(rwa.balanceOf(maker), 100 ether);
        assertEq(rwa.balanceOf(taker), 0);
    }

    function testRejectsFeeOnTransferTokenAndRollsBackFillState() public {
        FeeTransferToken taxed = new FeeTransferToken();
        taxed.mint(taker, 100_000 ether);
        vm.prank(taker);
        taxed.approve(address(settlement), type(uint256).max);

        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.buyToken = address(taxed);
        bytes memory signature = _sign(order);

        vm.expectRevert(bytes("TOKEN_TRANSFER_AMOUNT"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);

        assertEq(settlement.filled(orderDigest(order)), 0);
        assertEq(rwa.balanceOf(maker), 100 ether);
        assertEq(taxed.balanceOf(maker), 0);
    }

    function testSupportsERC1271ContractWalletSignatures() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet();
        rwa.mint(address(wallet), 10 ether);
        wallet.approveToken(rwa, address(settlement), type(uint256).max);

        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.maker = address(wallet);
        wallet.setValidHash(settlement.orderDigest(order));

        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, "");

        assertEq(rwa.balanceOf(taker), 10 ether);
        assertEq(usdx.balanceOf(address(wallet)), 20_000 ether);
    }

    function testSupportsPartialFillsWithoutOverfill() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);

        vm.prank(taker);
        _fillEligible(order, 4 ether, 8_000 ether, signature);
        vm.prank(taker);
        _fillEligible(order, 6 ether, 12_000 ether, signature);

        assertEq(rwa.balanceOf(taker), 10 ether);
        assertEq(usdx.balanceOf(maker), 20_000 ether);
        assertEq(settlement.filled(orderDigest(order)), 10 ether);
        vm.expectRevert(bytes("ORDER_ALREADY_FILLED"));
        vm.prank(taker);
        _fillEligible(order, 1 ether, 2_000 ether, signature);
    }

    function testFuzzPartialFillsStayWithinSignedAmount(uint96 firstSeed, uint96 secondSeed) public {
        uint256 signedAmount = 10 ether;
        uint256 firstAmount = bound(uint256(firstSeed), 1, signedAmount - 1);
        uint256 secondAmount = bound(uint256(secondSeed), 1, signedAmount - firstAmount);
        RFQSettlement.Order memory order = _order(signedAmount, 20_000 ether);
        bytes memory signature = _sign(order);

        vm.prank(taker);
        _fillEligible(order, firstAmount, firstAmount * 2_000, signature);
        vm.prank(taker);
        _fillEligible(order, secondAmount, secondAmount * 2_000, signature);

        uint256 filledAmount = firstAmount + secondAmount;
        assertEq(settlement.filled(orderDigest(order)), filledAmount);
        if (filledAmount < signedAmount) {
            vm.expectRevert(bytes("ORDER_ALREADY_FILLED"));
            vm.prank(taker);
            _fillEligible(
                order, signedAmount - filledAmount + 1, (signedAmount - filledAmount + 1) * 2_000, signature
            );
        } else {
            vm.expectRevert(bytes("ORDER_ALREADY_FILLED"));
            vm.prank(taker);
            _fillEligible(order, 1, 2_000, signature);
        }
    }

    function testFillOrKillRejectsPartialFill() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.fillMode = 1;
        bytes memory signature = _sign(order);
        vm.expectRevert(bytes("FILL_OR_KILL"));
        vm.prank(taker);
        _fillEligible(order, 9 ether, 18_000 ether, signature);
    }

    function testMakerCancellationAndPairSaltCancellationBlockFill() public {
        RFQSettlement.Order memory cancelledOrder = _order(10 ether, 20_000 ether);
        bytes memory cancelledSignature = _sign(cancelledOrder);
        vm.prank(maker);
        settlement.cancel(cancelledOrder);
        vm.expectRevert(bytes("ORDER_CANCELLED"));
        vm.prank(taker);
        _fillEligible(cancelledOrder, 10 ether, 20_000 ether, cancelledSignature);

        RFQSettlement.Order memory pairCancelledOrder = _order(10 ether, 20_000 ether);
        pairCancelledOrder.nonce = 8;
        bytes memory pairCancelledSignature = _sign(pairCancelledOrder);
        vm.prank(maker);
        settlement.cancelPairSalt(pairCancelledOrder.pairSalt);
        vm.expectRevert(bytes("PAIR_SALT_CANCELLED"));
        vm.prank(taker);
        _fillEligible(pairCancelledOrder, 10 ether, 20_000 ether, pairCancelledSignature);
    }

    function testExpiredOrderCannotFill() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _sign(order);
        vm.warp(order.expiry + 1);
        vm.expectRevert(bytes("ORDER_EXPIRED"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);
    }

    function testRejectsUnknownOrderAndFillModes() public {
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        order.orderType = 2;
        bytes memory signature = _sign(order);
        vm.expectRevert(bytes("ORDER_TYPE"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);

        order = _order(10 ether, 20_000 ether);
        order.fillMode = 2;
        signature = _sign(order);
        vm.expectRevert(bytes("ORDER_TYPE"));
        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);
    }

    function testSettlementDoesNotAssessASecondProtocolFee() public {
        RFQSettlement.Order memory order = _order(10 ether, 19_900 ether);
        order.feeBps = 50;
        bytes memory signature = _sign(order);

        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);

        assertEq(usdx.balanceOf(maker), 20_000 ether);
        assertEq(usdx.balanceOf(address(this)), 0);
    }

    function testScopedDelegatedSignerCanFillOnlyItsConfiguredOrderScope() public {
        address delegate = vm.addr(DELEGATE_PK);
        vm.prank(maker);
        settlement.setDelegatedSigner(
            delegate,
            address(rwa),
            address(usdx),
            10 ether,
            uint64(block.timestamp + 1 days),
            0,
            true
        );
        RFQSettlement.Order memory order = _order(10 ether, 20_000 ether);
        bytes memory signature = _signWith(order, DELEGATE_PK);

        vm.prank(taker);
        _fillEligible(order, 10 ether, 20_000 ether, signature);
        assertEq(rwa.balanceOf(taker), 10 ether);
        assertEq(settlement.delegatedConsumed(maker, delegate), 10 ether);
    }

    function testDelegatedSignerAggregateNotionalCap() public {
        address delegate = vm.addr(DELEGATE_PK);
        vm.prank(maker);
        settlement.setDelegatedSigner(
            delegate,
            address(rwa),
            address(usdx),
            10 ether,
            uint64(block.timestamp + 1 days),
            0,
            true
        );

        RFQSettlement.Order memory first = _order(6 ether, 12_000 ether);
        first.nonce = 1;
        bytes memory firstSig = _signWith(first, DELEGATE_PK);
        vm.prank(taker);
        _fillEligible(first, 6 ether, 12_000 ether, firstSig);
        assertEq(settlement.delegatedConsumed(maker, delegate), 6 ether);

        // Second order within remaining 4 ether capacity.
        RFQSettlement.Order memory second = _order(4 ether, 8_000 ether);
        second.nonce = 2;
        bytes memory secondSig = _signWith(second, DELEGATE_PK);
        vm.prank(taker);
        _fillEligible(second, 4 ether, 8_000 ether, secondSig);
        assertEq(settlement.delegatedConsumed(maker, delegate), 10 ether);

        // Third order exceeds aggregate cap even though per-order amount looks fine.
        RFQSettlement.Order memory third = _order(1 ether, 2_000 ether);
        third.nonce = 3;
        bytes memory thirdSig = _signWith(third, DELEGATE_PK);
        vm.expectRevert(bytes("INVALID_SIGNATURE"));
        vm.prank(taker);
        _fillEligible(third, 1 ether, 2_000 ether, thirdSig);
    }

    function testDelegatedSignerScopeRejectsOverLimitAndRevocation() public {
        address delegate = vm.addr(DELEGATE_PK);
        vm.prank(maker);
        settlement.setDelegatedSigner(
            delegate,
            address(rwa),
            address(usdx),
            10 ether,
            uint64(block.timestamp + 1 days),
            0,
            true
        );
        RFQSettlement.Order memory overLimit = _order(11 ether, 22_000 ether);
        bytes memory overLimitSignature = _signWith(overLimit, DELEGATE_PK);
        // Aggregate would be 11 > 10 even on first fill.
        vm.expectRevert(bytes("DELEGATION_CAP"));
        vm.prank(taker);
        _fillEligible(overLimit, 11 ether, 22_000 ether, overLimitSignature);

        vm.prank(maker);
        settlement.revokeDelegatedSigner(delegate);
        RFQSettlement.Order memory revoked = _order(10 ether, 20_000 ether);
        bytes memory revokedSignature = _signWith(revoked, DELEGATE_PK);
        vm.expectRevert(bytes("INVALID_SIGNATURE"));
        vm.prank(taker);
        _fillEligible(revoked, 10 ether, 20_000 ether, revokedSignature);
    }

    function orderDigest(RFQSettlement.Order memory order) internal view returns (bytes32) {
        return settlement.orderDigest(order);
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

    /// @dev Public standing order (orderType=1) for direct eligible fills.
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
        return _signWith(order, MAKER_PK);
    }

    function _signWith(RFQSettlement.Order memory order, uint256 privateKey) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, settlement.orderDigest(order));
        return abi.encodePacked(r, s, v);
    }
}

contract HighFeeRouter {
    uint16 public protocolFeeBps;

    constructor(uint16 feeBps) {
        protocolFeeBps = feeBps;
    }
}
