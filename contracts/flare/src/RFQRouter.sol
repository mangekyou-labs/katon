// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Route {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IRouteSource {
    function execute(
        address seller,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minOutput,
        bytes calldata sourceData
    ) external returns (uint256 reportedOutput);
}

interface IEligibilityRegistryRoute {
    function requireEligible(
        bytes32 policyId,
        address wallet,
        uint256 role,
        bytes32 issuerReference,
        uint256 expectedRevocationEpoch
    ) external view;
}

interface ILiquidationFundingSourceRoute {
    function fund(address recipient, address debtToken, uint256 amount) external returns (uint256 funded);
}

interface ILiquidationAdapterRoute {
    function liquidate(
        address venue,
        address market,
        bytes32 position,
        address debtToken,
        address collateralToken,
        uint256 maxRepay,
        address recipient,
        bytes calldata adapterData
    ) external returns (uint256 repaid);
}

interface IFccQuorumVerifierRoute {
    function quorum(bytes32 actionId) external view returns (bool ready, bytes32 selectedHash);
}

contract RFQRouter {
    struct Leg {
        address source;
        uint256 sellAmount;
        uint256 minOutput;
        bytes sourceData;
    }

    struct RoutePlan {
        uint256 chainId;
        address router;
        bytes32 commitment;
        uint256 decisionBlock;
        bytes32 decisionBlockHash;
        uint256 deadline;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minOutput;
        Leg[] legs;
    }

    struct SwapRoutePlan {
        uint256 chainId;
        address router;
        bytes32 commitment;
        bytes32 fccActionId;
        uint256 decisionBlock;
        bytes32 decisionBlockHash;
        uint256 deadline;
        address seller;
        address recipient;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minOutput;
        uint16 protocolFeeBps;
        bytes32 eligibilityPolicyId;
        uint256 eligibilityRevocationEpoch;
        uint256 eligibilityRole;
        bytes32 eligibilityIssuerReference;
        Leg[] legs;
    }

    struct LiquidationRoutePlan {
        uint256 chainId;
        address router;
        bytes32 commitment;
        bytes32 fccActionId;
        uint256 decisionBlock;
        bytes32 decisionBlockHash;
        uint256 deadline;
        address winner;
        address recipient;
        address venue;
        address market;
        bytes32 position;
        address debtToken;
        address collateralToken;
        uint256 maxRepay;
        uint256 minNetCollateral;
        uint16 protocolFeeBps;
        address fundingSource;
        address liquidationAdapter;
        bytes32 eligibilityPolicyId;
        uint256 eligibilityRevocationEpoch;
        uint256 eligibilityRole;
        bytes32 eligibilityIssuerReference;
    }

    address public owner;
    address public feeRecipient;
    address public eligibilityRegistry;
    uint16 public protocolFeeBps;
    bool public paused;
    uint256 public maxDecisionBlockAge = 256;
    bool public decisionBlockHashRequired;
    mapping(address source => bool allowed) public allowedSource;
    mapping(address source => bool allowed) public allowedLiquidationFundingSource;
    mapping(address adapter => bool allowed) public allowedLiquidationAdapter;
    mapping(bytes32 commitment => bool executed) public executedCommitment;
    uint256 private reentrancyLock = 1;
    address public guardian;
    /// @notice Compatibility-only route. Disabled by default; typed routes are the release path.
    /// @dev Appended to preserve the existing proxy storage layout.
    bool public legacyRouteEnabled;
    address public fccQuorumVerifier;

    event SourceConfigured(address indexed source, bool allowed);
    event SnapshotPolicyConfigured(uint256 maxAge, bool hashRequired);
    event RouteExecuted(bytes32 indexed commitment, address indexed seller, uint256 inputAmount, uint256 outputAmount);
    event EligibilityRegistryConfigured(address indexed registry);
    event ProtocolFeeConfigured(uint16 feeBps, address indexed recipient);
    event LiquidationFundingSourceConfigured(address indexed source, bool allowed);
    event LiquidationAdapterConfigured(address indexed adapter, bool allowed);
    event RouterPaused(bool paused);
    event LegacyRouteConfigured(bool enabled);
    event FccQuorumVerifierConfigured(address indexed verifier);
    event SwapRouteExecuted(bytes32 indexed commitment, address indexed seller, address indexed recipient, address sellToken, address buyToken, uint256 inputAmount, uint256 grossOutput, uint256 netOutput);
    event LiquidationRouteExecuted(bytes32 indexed commitment, address indexed winner, address indexed recipient, address venue, address market, bytes32 position, uint256 repaid, uint256 netCollateral);

    modifier nonReentrant() {
        require(reentrancyLock == 1, "ROUTER_REENTRANT");
        reentrancyLock = 2;
        _;
        reentrancyLock = 1;
    }

    constructor() {
        owner = msg.sender;
        feeRecipient = msg.sender;
    }

    function initialize(address owner_, address feeRecipient_) external {
        require(owner == address(0), "ALREADY_INITIALIZED");
        require(owner_ != address(0) && feeRecipient_ != address(0), "OWNER_REQUIRED");
        owner = owner_;
        feeRecipient = feeRecipient_;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_REQUIRED");
        owner = newOwner;
    }

    function setSource(address source, bool allowed) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(source != address(0), "SOURCE_REQUIRED");
        allowedSource[source] = allowed;
        emit SourceConfigured(source, allowed);
    }

    function setPaused(bool value) external {
        require(msg.sender == owner, "ONLY_OWNER");
        paused = value;
        emit RouterPaused(value);
    }

    function setLegacyRouteEnabled(bool value) external {
        require(msg.sender == owner, "ONLY_OWNER");
        legacyRouteEnabled = value;
        emit LegacyRouteConfigured(value);
    }

    function setGuardian(address guardian_) external {
        require(msg.sender == owner, "ONLY_OWNER");
        guardian = guardian_;
    }

    function guardianPause() external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        paused = true;
        emit RouterPaused(true);
    }

    function setEligibilityRegistry(address registry) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(registry != address(0), "REGISTRY_REQUIRED");
        eligibilityRegistry = registry;
        emit EligibilityRegistryConfigured(registry);
    }

    function setFccQuorumVerifier(address verifier) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(verifier != address(0), "FCC_VERIFIER_REQUIRED");
        fccQuorumVerifier = verifier;
        emit FccQuorumVerifierConfigured(verifier);
    }

    function setProtocolFeeBps(uint16 feeBps) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(feeBps <= 50, "FEE_TOO_HIGH");
        protocolFeeBps = feeBps;
        emit ProtocolFeeConfigured(feeBps, feeRecipient);
    }

    function setLiquidationFundingSource(address source, bool allowed) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(source != address(0), "SOURCE_REQUIRED");
        allowedLiquidationFundingSource[source] = allowed;
        emit LiquidationFundingSourceConfigured(source, allowed);
    }

    function setLiquidationAdapter(address adapter, bool allowed) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(adapter != address(0), "ADAPTER_REQUIRED");
        allowedLiquidationAdapter[adapter] = allowed;
        emit LiquidationAdapterConfigured(adapter, allowed);
    }

    function setSnapshotPolicy(uint256 maxAge, bool hashRequired) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(maxAge <= 256, "SNAPSHOT_AGE");
        maxDecisionBlockAge = maxAge;
        decisionBlockHashRequired = hashRequired;
        emit SnapshotPolicyConfigured(maxAge, hashRequired);
    }

    function executeRoute(RoutePlan calldata route) external nonReentrant {
        require(legacyRouteEnabled, "LEGACY_ROUTE_DISABLED");
        require(!paused, "ROUTER_PAUSED");
        require(route.chainId == block.chainid, "CHAIN_ID");
        require(route.router == address(this), "ROUTER_IDENTITY");
        require(route.decisionBlock <= block.number, "SNAPSHOT_FUTURE");
        require(block.number - route.decisionBlock <= maxDecisionBlockAge, "SNAPSHOT_STALE");
        if (decisionBlockHashRequired) {
            require(route.decisionBlockHash != bytes32(0), "SNAPSHOT_HASH_REQUIRED");
            require(blockhash(route.decisionBlock) == route.decisionBlockHash, "SNAPSHOT_HASH");
        }
        require(route.deadline >= block.timestamp, "ROUTE_EXPIRED");
        require(route.commitment != bytes32(0), "COMMITMENT_REQUIRED");
        require(!executedCommitment[route.commitment], "COMMITMENT_REPLAY");
        require(route.sellToken != address(0) && route.buyToken != address(0), "TOKEN_REQUIRED");
        require(route.sellToken != route.buyToken, "TOKEN_PAIR");
        require(route.sellAmount > 0 && route.legs.length > 0, "EMPTY_ROUTE");

        uint256 inputTotal;
        uint256 initialBalance = IERC20Route(route.buyToken).balanceOf(address(this));
        uint256 balanceBefore = initialBalance;
        for (uint256 i; i < route.legs.length; i++) {
            Leg calldata leg = route.legs[i];
            require(allowedSource[leg.source], "SOURCE_NOT_ALLOWED");
            require(leg.sellAmount > 0, "LEG_AMOUNT");
            inputTotal += leg.sellAmount;
            try IRouteSource(leg.source).execute(
                msg.sender,
                route.sellToken,
                route.buyToken,
                leg.sellAmount,
                leg.minOutput,
                leg.sourceData
            ) returns (uint256) {} catch {
                revert("SOURCE_CALL_FAILED");
            }
            uint256 balanceAfter = IERC20Route(route.buyToken).balanceOf(address(this));
            require(balanceAfter >= balanceBefore, "OUTPUT_BALANCE_DECREASED");
            require(balanceAfter - balanceBefore >= leg.minOutput, "LEG_MIN_OUTPUT");
            balanceBefore = balanceAfter;
        }
        require(inputTotal == route.sellAmount, "INPUT_MISMATCH");
        uint256 finalBalance = IERC20Route(route.buyToken).balanceOf(address(this));
        require(finalBalance >= initialBalance, "OUTPUT_BALANCE_DECREASED");
        uint256 totalOutput = finalBalance - initialBalance;
        require(totalOutput >= route.minOutput, "MIN_OUTPUT");
        executedCommitment[route.commitment] = true;
        _safeTransfer(route.buyToken, msg.sender, totalOutput);
        emit RouteExecuted(route.commitment, msg.sender, inputTotal, totalOutput);
    }

    function executeSwapRoute(SwapRoutePlan calldata route) external nonReentrant {
        require(!paused, "ROUTER_PAUSED");
        require(route.chainId == block.chainid, "CHAIN_ID");
        require(route.router == address(this), "ROUTER_IDENTITY");
        require(msg.sender == route.seller, "SELLER_BINDING");
        require(route.recipient != address(0), "RECIPIENT_REQUIRED");
        require(route.decisionBlock <= block.number, "SNAPSHOT_FUTURE");
        require(block.number - route.decisionBlock <= maxDecisionBlockAge, "SNAPSHOT_STALE");
        if (decisionBlockHashRequired) {
            require(route.decisionBlockHash != bytes32(0), "SNAPSHOT_HASH_REQUIRED");
            require(blockhash(route.decisionBlock) == route.decisionBlockHash, "SNAPSHOT_HASH");
        }
        require(route.deadline >= block.timestamp, "ROUTE_EXPIRED");
        require(route.commitment != bytes32(0), "COMMITMENT_REQUIRED");
        require(!executedCommitment[route.commitment], "COMMITMENT_REPLAY");
        require(route.sellToken != address(0) && route.buyToken != address(0), "TOKEN_REQUIRED");
        require(route.sellToken != route.buyToken, "TOKEN_PAIR");
        require(route.sellAmount > 0 && route.legs.length > 0, "EMPTY_ROUTE");
        require(route.protocolFeeBps == protocolFeeBps, "FEE_MISMATCH");
        require(route.protocolFeeBps <= 50, "FEE_TOO_HIGH");
        require(eligibilityRegistry != address(0), "REGISTRY_REQUIRED");
        IEligibilityRegistryRoute(eligibilityRegistry).requireEligible(
            route.eligibilityPolicyId,
            route.seller,
            route.eligibilityRole,
            route.eligibilityIssuerReference,
            route.eligibilityRevocationEpoch
        );
        _requireFccQuorum(route.fccActionId, hashSwapRoute(route));

        uint256 initialBalance = IERC20Route(route.buyToken).balanceOf(address(this));
        uint256 balanceBefore = initialBalance;
        uint256 inputTotal;
        for (uint256 i; i < route.legs.length; i++) {
            Leg calldata leg = route.legs[i];
            require(allowedSource[leg.source], "SOURCE_NOT_ALLOWED");
            require(leg.sellAmount > 0, "LEG_AMOUNT");
            inputTotal += leg.sellAmount;
            try IRouteSource(leg.source).execute(
                route.seller,
                route.sellToken,
                route.buyToken,
                leg.sellAmount,
                leg.minOutput,
                leg.sourceData
            ) returns (uint256) {} catch Error(string memory reason) {
                revert(reason);
            } catch {
                revert("SOURCE_CALL_FAILED");
            }
            uint256 balanceAfter = IERC20Route(route.buyToken).balanceOf(address(this));
            require(balanceAfter >= balanceBefore, "OUTPUT_BALANCE_DECREASED");
            require(balanceAfter - balanceBefore >= leg.minOutput, "LEG_MIN_OUTPUT");
            balanceBefore = balanceAfter;
        }
        require(inputTotal == route.sellAmount, "INPUT_MISMATCH");
        uint256 totalOutput = IERC20Route(route.buyToken).balanceOf(address(this)) - initialBalance;
        uint256 fee = (totalOutput * route.protocolFeeBps) / 10_000;
        uint256 netOutput = totalOutput - fee;
        require(netOutput >= route.minOutput, "MIN_OUTPUT");
        executedCommitment[route.commitment] = true;
        if (fee > 0) _safeTransfer(route.buyToken, feeRecipient, fee);
        _safeTransfer(route.buyToken, route.recipient, netOutput);
        emit RouteExecuted(route.commitment, route.seller, inputTotal, netOutput);
        emit SwapRouteExecuted(route.commitment, route.seller, route.recipient, route.sellToken, route.buyToken, inputTotal, totalOutput, netOutput);
    }

    function executeLiquidationRoute(LiquidationRoutePlan calldata route) external nonReentrant {
        require(!paused, "ROUTER_PAUSED");
        require(route.chainId == block.chainid, "CHAIN_ID");
        require(route.router == address(this), "ROUTER_IDENTITY");
        require(msg.sender == route.winner, "WINNER_BINDING");
        require(route.recipient != address(0), "RECIPIENT_REQUIRED");
        require(route.decisionBlock <= block.number, "SNAPSHOT_FUTURE");
        require(block.number - route.decisionBlock <= maxDecisionBlockAge, "SNAPSHOT_STALE");
        if (decisionBlockHashRequired) {
            require(route.decisionBlockHash != bytes32(0), "SNAPSHOT_HASH_REQUIRED");
            require(blockhash(route.decisionBlock) == route.decisionBlockHash, "SNAPSHOT_HASH");
        }
        require(route.deadline >= block.timestamp, "ROUTE_EXPIRED");
        require(route.commitment != bytes32(0), "COMMITMENT_REQUIRED");
        require(!executedCommitment[route.commitment], "COMMITMENT_REPLAY");
        require(route.venue != address(0) && route.market != address(0), "VENUE_REQUIRED");
        require(route.debtToken != address(0) && route.collateralToken != address(0), "TOKEN_REQUIRED");
        require(route.debtToken != route.collateralToken, "TOKEN_PAIR");
        require(route.maxRepay > 0 && route.fundingSource != address(0), "LIQUIDATION_INPUT");
        require(route.liquidationAdapter != address(0), "ADAPTER_REQUIRED");
        require(route.protocolFeeBps == protocolFeeBps, "FEE_MISMATCH");
        require(route.protocolFeeBps <= 50, "FEE_TOO_HIGH");
        require(allowedLiquidationFundingSource[route.fundingSource], "FUNDING_NOT_ALLOWED");
        require(allowedLiquidationAdapter[route.liquidationAdapter], "ADAPTER_NOT_ALLOWED");
        require(eligibilityRegistry != address(0), "REGISTRY_REQUIRED");
        IEligibilityRegistryRoute(eligibilityRegistry).requireEligible(
            route.eligibilityPolicyId,
            route.winner,
            route.eligibilityRole,
            route.eligibilityIssuerReference,
            route.eligibilityRevocationEpoch
        );
        _requireFccQuorum(route.fccActionId, hashLiquidationRoute(route));

        uint256 debtBefore = IERC20Route(route.debtToken).balanceOf(address(this));
        uint256 collateralBefore = IERC20Route(route.collateralToken).balanceOf(address(this));
        uint256 funded;
        try ILiquidationFundingSourceRoute(route.fundingSource).fund(address(this), route.debtToken, route.maxRepay)
        returns (uint256 amount) {
            funded = amount;
        } catch {
            revert("FUNDING_CALL_FAILED");
        }
        uint256 debtFunded = IERC20Route(route.debtToken).balanceOf(address(this)) - debtBefore;
        require(funded == route.maxRepay && debtFunded == route.maxRepay, "FUNDING_AMOUNT");
        _safeApprove(route.debtToken, route.liquidationAdapter, route.maxRepay);

        uint256 reportedRepaid;
        try ILiquidationAdapterRoute(route.liquidationAdapter).liquidate(
            route.venue,
            route.market,
            route.position,
            route.debtToken,
            route.collateralToken,
            route.maxRepay,
            address(this),
            ""
        ) returns (uint256 amount) {
            reportedRepaid = amount;
        } catch {
            revert("LIQUIDATION_CALL_FAILED");
        }
        uint256 debtAfter = IERC20Route(route.debtToken).balanceOf(address(this));
        uint256 debtSpent = debtBefore + route.maxRepay - debtAfter;
        require(reportedRepaid == route.maxRepay && debtSpent == route.maxRepay, "REPAYMENT_AMOUNT");
        _safeApprove(route.debtToken, route.liquidationAdapter, 0);

        uint256 collateralAfter = IERC20Route(route.collateralToken).balanceOf(address(this));
        require(collateralAfter >= collateralBefore, "COLLATERAL_BALANCE_DECREASED");
        uint256 grossCollateral = collateralAfter - collateralBefore;
        uint256 fee = (grossCollateral * route.protocolFeeBps) / 10_000;
        uint256 netCollateral = grossCollateral - fee;
        require(netCollateral >= route.minNetCollateral, "MIN_OUTPUT");
        executedCommitment[route.commitment] = true;
        if (fee > 0) _safeTransfer(route.collateralToken, feeRecipient, fee);
        _safeTransfer(route.collateralToken, route.recipient, netCollateral);
        emit RouteExecuted(route.commitment, route.winner, route.maxRepay, netCollateral);
        _emitLiquidationRouteExecuted(route, netCollateral);
    }

    function _emitLiquidationRouteExecuted(LiquidationRoutePlan calldata route, uint256 netCollateral) private {
        emit LiquidationRouteExecuted(
            route.commitment,
            route.winner,
            route.recipient,
            route.venue,
            route.market,
            route.position,
            route.maxRepay,
            netCollateral
        );
    }

    /// @notice Protocol fee charged on a gross output at the live `protocolFeeBps`.
    function protocolFeeOn(uint256 amount) public view returns (uint256) {
        return (amount * protocolFeeBps) / 10_000;
    }

    function hashSwapRoute(SwapRoutePlan calldata route) public pure returns (bytes32) {
        return keccak256(abi.encode(route));
    }

    function hashLiquidationRoute(LiquidationRoutePlan calldata route) public pure returns (bytes32) {
        return keccak256(abi.encode(route));
    }

    function _requireFccQuorum(bytes32 actionId, bytes32 expectedHash) private view {
        require(fccQuorumVerifier != address(0), "FCC_VERIFIER_REQUIRED");
        require(actionId != bytes32(0), "FCC_ACTION_REQUIRED");
        (bool ready, bytes32 selectedHash) = IFccQuorumVerifierRoute(fccQuorumVerifier).quorum(actionId);
        require(ready, "FCC_QUORUM_UNAVAILABLE");
        require(selectedHash == expectedHash, "FCC_RESULT_MISMATCH");
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20Route.approve.selector, spender, amount)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "TOKEN_APPROVE_FAILED");
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20Route.transfer.selector, to, amount)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "TOKEN_TRANSFER_FAILED");
    }
}
