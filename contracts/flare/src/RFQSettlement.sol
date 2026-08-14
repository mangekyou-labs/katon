// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC1271Minimal {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

interface IEligibilityRegistrySettlement {
    function requireEligible(
        bytes32 policyId,
        address wallet,
        uint256 role,
        bytes32 issuerReference,
        uint256 expectedRevocationEpoch
    ) external view;
}

interface ISettlementRouteToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IRouterFeeView {
    function protocolFeeBps() external view returns (uint16);
}

contract RFQSettlement {
    struct Order {
        address maker;
        address taker;
        address executor;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        uint256 expiry;
        uint256 nonce;
        bytes32 pairSalt;
        bytes32 contextCommitment;
        uint8 orderType;
        uint8 fillMode;
        uint16 feeBps;
    }

    struct Delegation {
        address sellToken;
        address buyToken;
        uint256 maxSellAmount;
        uint64 expiry;
        uint8 fillMode;
        bool active;
    }

    struct RouteFill {
        Order order;
        uint256 orderSellAmount;
        uint256 orderBuyAmount;
        bytes signature;
    }

    /// @dev Memory bag for fill execution — keeps local stack depth under the Yul limit.
    struct FillCtx {
        uint256 sellAmount;
        uint256 buyAmount;
        address payer;
        address taker;
        address outputRecipient;
        address authorizedExecutor;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address taker,address executor,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint64 expiry,uint256 nonce,bytes32 pairSalt,bytes32 contextCommitment,uint8 orderType,uint8 fillMode,uint16 feeBps)"
    );
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 private constant MAX_FEE_BPS = 50;
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    bytes32 public DOMAIN_SEPARATOR;
    address public feeRecipient;
    address public router;
    address public eligibilityRegistry;
    mapping(bytes32 orderHash => uint256 amount) public filled;
    mapping(bytes32 orderHash => bool) public cancelled;
    mapping(address maker => mapping(bytes32 pairSalt => bool)) public pairSaltCancelled;
    mapping(address maker => mapping(address signer => Delegation)) public delegatedSigner;
    mapping(address maker => mapping(address signer => uint256 consumed)) public delegatedConsumed;
    address public guardian;
    bool public paused;
    uint256 private reentrancyLock = 1;

    event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 sellAmount, uint256 buyAmount);
    event ProtocolFeeCollected(bytes32 indexed orderHash, address indexed recipient, uint256 amount);
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event PairSaltAdvanced(address indexed maker, bytes32 indexed pairSalt);
    event DelegatedSignerConfigured(address indexed maker, address indexed signer, bool active);
    event RouterConfigured(address indexed router);

    modifier nonReentrant() {
        require(reentrancyLock == 1, "REENTRANT");
        reentrancyLock = 2;
        _;
        reentrancyLock = 1;
    }

    constructor() {
        _initialize(msg.sender);
    }

    function initialize(address owner_) external {
        require(feeRecipient == address(0), "ALREADY_INITIALIZED");
        require(owner_ != address(0), "OWNER_REQUIRED");
        _initialize(owner_);
    }

    function _initialize(address owner_) private {
        feeRecipient = owner_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("TrustRFQ"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == feeRecipient, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_REQUIRED");
        feeRecipient = newOwner;
    }

    function setGuardian(address guardian_) external {
        require(msg.sender == feeRecipient, "ONLY_OWNER");
        guardian = guardian_;
    }

    function setPaused(bool value) external {
        require(msg.sender == feeRecipient, "ONLY_OWNER");
        paused = value;
    }

    function guardianPause() external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        paused = true;
    }

    function setEligibilityRegistry(address registry) external {
        require(msg.sender == feeRecipient, "ONLY_OWNER");
        require(registry != address(0), "REGISTRY_REQUIRED");
        eligibilityRegistry = registry;
    }

    function setRouter(address router_) external {
        require(msg.sender == feeRecipient, "ONLY_OWNER");
        require(router_ != address(0), "ROUTER_REQUIRED");
        router = router_;
        emit RouterConfigured(router_);
    }

    function orderDigest(Order memory order) public view returns (bytes32) {
        return _digest(_structHash(order));
    }

    /// @notice Remaining maker sell amount that can still settle against `order`.
    function remainingFillable(Order calldata order) external view returns (uint256) {
        bytes32 hash = orderDigest(order);
        if (cancelled[hash] || pairSaltCancelled[order.maker][order.pairSalt]) {
            return 0;
        }
        uint256 alreadyFilled = filled[hash];
        if (alreadyFilled >= order.sellAmount) {
            return 0;
        }
        return order.sellAmount - alreadyFilled;
    }

    function setDelegatedSigner(
        address signer,
        address sellToken,
        address buyToken,
        uint256 maxSellAmount,
        uint64 expiry,
        uint8 fillMode,
        bool active
    ) external {
        require(signer != address(0), "SIGNER_REQUIRED");
        require(sellToken != address(0) && buyToken != address(0) && sellToken != buyToken, "TOKEN_PAIR");
        require(maxSellAmount > 0, "AMOUNT_REQUIRED");
        require(expiry >= block.timestamp, "DELEGATION_EXPIRED");
        require(fillMode <= 1, "FILL_MODE");
        delegatedSigner[msg.sender][signer] = Delegation({
            sellToken: sellToken,
            buyToken: buyToken,
            maxSellAmount: maxSellAmount,
            expiry: expiry,
            fillMode: fillMode,
            active: active
        });
        if (!active) {
            delegatedConsumed[msg.sender][signer] = 0;
        }
        emit DelegatedSignerConfigured(msg.sender, signer, active);
    }

    function revokeDelegatedSigner(address signer) external {
        require(signer != address(0), "SIGNER_REQUIRED");
        delegatedSigner[msg.sender][signer].active = false;
        delegatedConsumed[msg.sender][signer] = 0;
        emit DelegatedSignerConfigured(msg.sender, signer, false);
    }

    /// @notice Direct fund-moving fill requires a live eligibility snapshot.
    function fill(Order calldata, uint256, uint256, bytes calldata) external pure {
        revert("ELIGIBILITY_REQUIRED");
    }

    function fillWithEligibility(
        Order calldata order,
        uint256 sellAmount,
        uint256 buyAmount,
        bytes calldata signature,
        bytes32 policyId,
        uint256 expectedRevocationEpoch,
        uint256 role,
        bytes32 issuerReference
    ) external nonReentrant {
        require(!paused, "SETTLEMENT_PAUSED");
        require(eligibilityRegistry != address(0), "REGISTRY_REQUIRED");
        // Confidential RFQ orders must settle through the bound executor (router).
        require(order.executor == address(0), "EXECUTOR_RESTRICTED");
        IEligibilityRegistrySettlement(eligibilityRegistry).requireEligible(
            policyId, msg.sender, role, issuerReference, expectedRevocationEpoch
        );
        FillCtx memory ctx = FillCtx({
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            payer: msg.sender,
            taker: msg.sender,
            outputRecipient: msg.sender,
            authorizedExecutor: address(0)
        });
        _fill(order, ctx, signature);
    }

    /// @notice Typed router source for an LP order. The seller pays the order's
    /// buy token while the router receives the maker's sell token as gross output.
    function execute(
        address seller,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minOutput,
        bytes calldata sourceData
    ) external nonReentrant returns (uint256 reportedOutput) {
        require(msg.sender == router, "EXECUTE_AUTH");
        require(seller != address(0) && sellAmount > 0, "EXECUTE_INPUT");
        RouteFill memory routeFill = abi.decode(sourceData, (RouteFill));
        // Open-taker standing (taker==0) is reusable across sellers; bound takers still match.
        require(routeFill.order.taker == address(0) || routeFill.order.taker == seller, "TAKER_RESTRICTED");
        require(routeFill.order.sellToken == buyToken && routeFill.order.buyToken == sellToken, "EXECUTE_PAIR");
        require(routeFill.orderBuyAmount == sellAmount && routeFill.orderSellAmount >= minOutput, "EXECUTE_OUTPUT");
        // Executor binding: zero = public standing; nonzero must equal this router.
        require(
            routeFill.order.executor == address(0) || routeFill.order.executor == msg.sender,
            "EXECUTOR_RESTRICTED"
        );
        // Maker-signed feeBps is a hard upper bound on the router's active fee.
        if (router != address(0)) {
            require(routeFill.order.feeBps >= IRouterFeeView(router).protocolFeeBps(), "FEE_CAP");
        }
        FillCtx memory ctx = FillCtx({
            sellAmount: routeFill.orderSellAmount,
            buyAmount: routeFill.orderBuyAmount,
            payer: seller,
            taker: seller,
            outputRecipient: msg.sender,
            authorizedExecutor: msg.sender
        });
        _fill(routeFill.order, ctx, routeFill.signature);
        return routeFill.orderSellAmount;
    }

    function _fill(Order memory order, FillCtx memory ctx, bytes memory signature) internal {
        _validateOrderBasics(order, ctx);
        bytes32 hash = orderDigest(order);
        _assertFillable(order, hash, ctx.sellAmount);
        _consumeSignature(order, hash, signature, ctx.sellAmount);
        filled[hash] = filled[hash] + ctx.sellAmount;
        _transferFillLegs(order, ctx);
        emit OrderFilled(hash, order.maker, ctx.taker, ctx.sellAmount, ctx.buyAmount);
    }

    function _validateOrderBasics(Order memory order, FillCtx memory ctx) private view {
        require(!paused, "SETTLEMENT_PAUSED");
        require(block.timestamp <= order.expiry, "ORDER_EXPIRED");
        require(order.expiry <= type(uint64).max, "EXPIRY_WIDTH");
        require(order.maker != address(0), "MAKER_REQUIRED");
        require(order.taker == address(0) || order.taker == ctx.taker, "TAKER_RESTRICTED");
        require(order.sellToken != order.buyToken, "TOKEN_PAIR");
        require(order.sellAmount > 0 && ctx.sellAmount > 0 && ctx.sellAmount <= order.sellAmount, "INVALID_AMOUNT");
        require(order.orderType <= 1 && order.fillMode <= 1, "ORDER_TYPE");
        require(order.feeBps <= MAX_FEE_BPS, "FEE_TOO_HIGH");
        if (order.fillMode == 1) require(ctx.sellAmount == order.sellAmount, "FILL_OR_KILL");
        _assertConfidentialBinding(order, ctx.authorizedExecutor);
        require(ctx.buyAmount >= _ceilProRata(order.minBuyAmount, ctx.sellAmount, order.sellAmount), "MIN_OUTPUT");
    }

    function _assertConfidentialBinding(Order memory order, address authorizedExecutor) private pure {
        // orderType 0 = confidential RFQ: taker, executor, and auction/route context are required.
        if (order.orderType != 0) return;
        require(order.taker != address(0), "TAKER_REQUIRED");
        require(order.executor != address(0), "EXECUTOR_REQUIRED");
        require(order.contextCommitment != bytes32(0), "CONTEXT_REQUIRED");
        require(authorizedExecutor == order.executor, "EXECUTOR_RESTRICTED");
    }

    function _ceilProRata(uint256 minBuyAmount, uint256 sellAmount, uint256 orderSellAmount)
        private
        pure
        returns (uint256)
    {
        return (minBuyAmount * sellAmount + orderSellAmount - 1) / orderSellAmount;
    }

    function _assertFillable(Order memory order, bytes32 hash, uint256 sellAmount) private view {
        require(!cancelled[hash], "ORDER_CANCELLED");
        require(!pairSaltCancelled[order.maker][order.pairSalt], "PAIR_SALT_CANCELLED");
        uint256 alreadyFilled = filled[hash];
        require(alreadyFilled == 0 || alreadyFilled + sellAmount <= order.sellAmount, "ORDER_ALREADY_FILLED");
    }

    function _consumeSignature(
        Order memory order,
        bytes32 hash,
        bytes memory signature,
        uint256 sellAmount
    ) private {
        address recoveredSigner = _validateSignature(order, hash, signature);
        require(recoveredSigner != address(0), "INVALID_SIGNATURE");
        if (recoveredSigner != order.maker && order.maker.code.length == 0) {
            uint256 consumed = delegatedConsumed[order.maker][recoveredSigner] + sellAmount;
            require(consumed <= delegatedSigner[order.maker][recoveredSigner].maxSellAmount, "DELEGATION_CAP");
            delegatedConsumed[order.maker][recoveredSigner] = consumed;
        }
    }

    function _transferFillLegs(Order memory order, FillCtx memory ctx) private {
        _safeTransferFromExact(order.sellToken, order.maker, ctx.outputRecipient, ctx.sellAmount);
        _safeTransferFromExact(order.buyToken, ctx.payer, order.maker, ctx.buyAmount);
    }

    function cancel(Order calldata order) external {
        require(msg.sender == order.maker, "ONLY_MAKER");
        bytes32 hash = orderDigest(order);
        cancelled[hash] = true;
        emit OrderCancelled(hash, msg.sender);
    }

    function cancelPairSalt(bytes32 pairSalt) external {
        pairSaltCancelled[msg.sender][pairSalt] = true;
        emit PairSaltAdvanced(msg.sender, pairSalt);
    }

    function _structHash(Order memory order) private pure returns (bytes32) {
        require(order.expiry <= type(uint64).max, "EXPIRY_WIDTH");
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
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
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @dev Returns the recovered EOA signer, the maker for ERC-1271, or address(0) on failure.
    function _validateSignature(Order memory order, bytes32 hash, bytes memory signature) private view returns (address) {
        address maker = order.maker;
        if (maker.code.length > 0) {
            (bool ok, bytes memory result) = maker.staticcall(
                abi.encodeWithSelector(IERC1271Minimal.isValidSignature.selector, hash, signature)
            );
            if (ok && result.length >= 4 && bytes4(result) == ERC1271_MAGIC_VALUE) {
                return maker;
            }
            return address(0);
        }
        address signer = _recover(hash, signature);
        if (signer == maker) return maker;
        Delegation memory delegation = delegatedSigner[maker][signer];
        if (
            delegation.active
                && block.timestamp <= delegation.expiry
                && order.expiry <= delegation.expiry
                && order.sellToken == delegation.sellToken
                && order.buyToken == delegation.buyToken
                && order.fillMode == delegation.fillMode
                && delegatedConsumed[maker][signer] < delegation.maxSellAmount
        ) {
            return signer;
        }
        return address(0);
    }

    function _recover(bytes32 hash, bytes memory signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > SECP256K1N_HALF) return address(0);
        return ecrecover(hash, v, r, s);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "TOKEN_TRANSFER_FAILED");
    }

    function _safeTransferFromExact(address token, address from, address to, uint256 amount) private {
        uint256 fromBefore = _balanceOf(token, from);
        uint256 toBefore = _balanceOf(token, to);
        _safeTransferFrom(token, from, to, amount);
        uint256 fromAfter = _balanceOf(token, from);
        uint256 toAfter = _balanceOf(token, to);
        require(
            fromBefore >= fromAfter
                && fromBefore - fromAfter == amount
                && toAfter >= toBefore
                && toAfter - toBefore == amount,
            "TOKEN_TRANSFER_AMOUNT"
        );
    }

    function _balanceOf(address token, address account) private view returns (uint256 balance) {
        (bool ok, bytes memory result) = token.staticcall(
            abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, account)
        );
        require(ok && result.length >= 32, "TOKEN_BALANCE_FAILED");
        return abi.decode(result, (uint256));
    }
}
