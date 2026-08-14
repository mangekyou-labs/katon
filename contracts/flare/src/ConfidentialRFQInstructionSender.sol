// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    function sendInstructions(address[] calldata teeIds, TeeInstructionParams calldata params) external payable returns (bytes32 instructionId);
}

interface ITeeMachineRegistry {
    function getRandomTeeIds(uint256 extensionId, uint256 count) external view returns (address[] memory teeIds);
}

contract ConfidentialRFQInstructionSender {
    bytes32 public constant OP_RFQ = bytes32("RFQ");
    bytes32 public constant OP_BID = bytes32("BID");
    bytes32 public constant OP_MATCH = bytes32("MATCH");
    bytes32 public constant OP_LIQUIDATION = bytes32("LIQUIDATION");
    bytes32 public constant COMMAND_CREATE = bytes32("CREATE");
    bytes32 public constant COMMAND_CANCEL = bytes32("CANCEL");
    bytes32 public constant COMMAND_SUBMIT = bytes32("SUBMIT");
    bytes32 public constant COMMAND_STANDING = bytes32("STANDING");
    bytes32 public constant COMMAND_QUOTE = bytes32("QUOTE");
    bytes32 public constant COMMAND_FINALIZE = bytes32("FINALIZE");

    address public owner;
    address public fccExtensionRegistry;
    address public fccMachineRegistry;
    uint256 public fccExtensionId;
    uint64 public fccQuorumThreshold;
    mapping(address tee => bool) public registeredTEE;
    mapping(bytes32 actionId => bytes32[]) private resultHashes;
    mapping(bytes32 actionId => mapping(bytes32 resultHash => uint256)) public resultCount;
    mapping(bytes32 actionId => mapping(address tee => bool)) public submitted;
    address public guardian;
    bool public paused;
    mapping(bytes32 actionId => mapping(address tee => bool)) public selectedTEE;
    mapping(bytes32 actionId => uint64 expiry) public actionExpiry;
    mapping(bytes32 instructionId => bytes32 actionId) public instructionToActionId;

    event InstructionDispatched(bytes32 indexed opType, bytes32 indexed command, bytes32 indexed actionId, bytes32 payloadCommitment, uint64 expiry);
    event TEERegistered(address indexed tee, bool registered);
    event FccConfigured(address indexed extensionRegistry, address indexed machineRegistry, uint256 extensionId, uint64 quorumThreshold);
    event FccInstructionSubmitted(bytes32 indexed instructionId, bytes32 indexed actionId, uint256 teeCount, uint64 quorumThreshold);

    constructor() {
        owner = msg.sender;
    }

    function initialize(address owner_) external {
        require(owner == address(0), "ALREADY_INITIALIZED");
        require(owner_ != address(0), "OWNER_REQUIRED");
        owner = owner_;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_REQUIRED");
        owner = newOwner;
    }

    function setGuardian(address guardian_) external {
        require(msg.sender == owner, "ONLY_OWNER");
        guardian = guardian_;
    }

    function setPaused(bool value) external {
        require(msg.sender == owner, "ONLY_OWNER");
        paused = value;
    }

    function guardianPause() external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        paused = true;
    }

    function configureFcc(address extensionRegistry, address machineRegistry, uint256 extensionId, uint64 quorumThreshold) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(fccExtensionRegistry == address(0) && fccMachineRegistry == address(0), "FCC_ALREADY_CONFIGURED");
        require(extensionRegistry != address(0) && machineRegistry != address(0), "FCC_REGISTRY_REQUIRED");
        require(extensionId >= 65536, "FCC_EXTENSION_ID");
        require(quorumThreshold == 2, "FCC_QUORUM_REQUIRED");
        fccExtensionRegistry = extensionRegistry;
        fccMachineRegistry = machineRegistry;
        fccExtensionId = extensionId;
        fccQuorumThreshold = quorumThreshold;
        emit FccConfigured(extensionRegistry, machineRegistry, extensionId, quorumThreshold);
    }

    function dispatchConfidential(
        bytes32 opType,
        bytes32 command,
        bytes32 actionId,
        bytes32 payloadCommitment,
        bytes calldata message,
        uint256 teeCount,
        uint64 expiry
    ) external payable returns (bytes32 instructionId) {
        require(!paused, "FCC_PAUSED");
        require(fccExtensionRegistry != address(0) && fccMachineRegistry != address(0), "FCC_NOT_CONFIGURED");
        require(_allowed(opType, command), "OP_NOT_ALLOWED");
        require(actionId != bytes32(0), "ACTION_REQUIRED");
        require(payloadCommitment != bytes32(0), "COMMITMENT_REQUIRED");
        require(message.length > 0, "MESSAGE_REQUIRED");
        require(keccak256(message) == payloadCommitment, "COMMITMENT_MISMATCH");
        require(expiry >= block.timestamp, "INSTRUCTION_EXPIRED");
        require(actionExpiry[actionId] == 0, "ACTION_REPLAY");
        require(teeCount == 3 && fccQuorumThreshold == 2, "FCC_TEE_COUNT");
        address[] memory teeIds = ITeeMachineRegistry(fccMachineRegistry).getRandomTeeIds(fccExtensionId, teeCount);
        require(teeIds.length == teeCount, "FCC_TEE_SELECTION");
        for (uint256 i; i < teeIds.length; i++) {
            require(teeIds[i] != address(0), "FCC_TEE_SELECTION");
            for (uint256 j = i + 1; j < teeIds.length; j++) {
                require(teeIds[i] != teeIds[j], "FCC_TEE_SELECTION");
            }
            selectedTEE[actionId][teeIds[i]] = true;
        }
        actionExpiry[actionId] = expiry;
        instructionId = _sendFccInstruction(teeIds, opType, command, message);
        require(instructionId != bytes32(0), "FCC_INSTRUCTION_ID");
        require(instructionToActionId[instructionId] == bytes32(0), "FCC_INSTRUCTION_REPLAY");
        instructionToActionId[instructionId] = actionId;
        emit FccInstructionSubmitted(instructionId, actionId, teeCount, fccQuorumThreshold);
    }

    function submitFccResult(
        bytes32 instructionId,
        bytes calldata resultData,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) external {
        require(fccExtensionRegistry != address(0), "FCC_NOT_CONFIGURED");
        require(instructionId != bytes32(0) && resultData.length == 32, "RESULT_SCHEMA");
        bytes32 actionId = instructionToActionId[instructionId];
        require(actionId != bytes32(0), "UNKNOWN_INSTRUCTION");
        require(actionExpiry[actionId] >= block.timestamp, "RESULT_EXPIRED");
        require(status == 1, "RESULT_STATUS");
        bytes32 resultHash = abi.decode(resultData, (bytes32));
        require(resultHash != bytes32(0), "RESULT_SCHEMA");
        bytes32 actionResultHash = keccak256(
            abi.encodePacked(keccak256(resultData), instructionId, keccak256(bytes(submissionTag)), status)
        );
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), block.chainid, actionResultHash));
        address tee = _recover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash)), signature);
        require(selectedTEE[actionId][tee], "TEE_NOT_SELECTED");
        require(!submitted[actionId][tee], "TEE_RESULT_REPLAY");
        submitted[actionId][tee] = true;
        if (resultCount[actionId][resultHash] == 0) resultHashes[actionId].push(resultHash);
        resultCount[actionId][resultHash] += 1;
    }

    function registerTEE(address tee) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(fccExtensionRegistry == address(0), "FCC_REAL_MODE");
        require(tee != address(0), "TEE_REQUIRED");
        registeredTEE[tee] = true;
        emit TEERegistered(tee, true);
    }

    function submitResult(bytes32 actionId, bytes32 resultHash, bool attested) external {
        require(fccExtensionRegistry == address(0), "FCC_REAL_MODE");
        require(registeredTEE[msg.sender], "TEE_NOT_REGISTERED");
        require(actionId != bytes32(0) && resultHash != bytes32(0), "RESULT_SCHEMA");
        require(!submitted[actionId][msg.sender], "TEE_RESULT_REPLAY");
        submitted[actionId][msg.sender] = true;
        if (!attested) return;
        if (resultCount[actionId][resultHash] == 0) resultHashes[actionId].push(resultHash);
        resultCount[actionId][resultHash] += 1;
    }

    function quorum(bytes32 actionId) external view returns (bool ready, bytes32 selectedHash) {
        bytes32[] memory hashes = resultHashes[actionId];
        for (uint256 i; i < hashes.length; i++) {
            if (resultCount[actionId][hashes[i]] < 2) continue;
            if (!ready || hashes[i] < selectedHash) {
                ready = true;
                selectedHash = hashes[i];
            }
        }
    }

    function dispatch(
        bytes32 opType,
        bytes32 command,
        bytes32 actionId,
        bytes32 payloadCommitment,
        uint64 expiry
    ) external {
        require(!paused, "FCC_PAUSED");
        require(fccExtensionRegistry == address(0), "FCC_REAL_MODE");
        require(expiry >= block.timestamp, "INSTRUCTION_EXPIRED");
        require(_allowed(opType, command), "OP_NOT_ALLOWED");
        require(actionId != bytes32(0), "ACTION_REQUIRED");
        require(payloadCommitment != bytes32(0), "COMMITMENT_REQUIRED");
        emit InstructionDispatched(opType, command, actionId, payloadCommitment, expiry);
    }

    function _allowed(bytes32 opType, bytes32 command) private pure returns (bool) {
        if (opType == OP_RFQ) return command == COMMAND_CREATE || command == COMMAND_CANCEL;
        if (opType == OP_BID) return command == COMMAND_SUBMIT || command == COMMAND_STANDING;
        if (opType == OP_MATCH) return command == COMMAND_QUOTE || command == COMMAND_FINALIZE;
        if (opType == OP_LIQUIDATION) return command == COMMAND_CREATE || command == COMMAND_FINALIZE;
        return false;
    }

    function _sendFccInstruction(
        address[] memory teeIds,
        bytes32 opType,
        bytes32 command,
        bytes calldata message
    ) private returns (bytes32) {
        address[] memory cosigners = new address[](0);
        return ITeeExtensionRegistry(fccExtensionRegistry).sendInstructions{value: msg.value}(
            teeIds,
            ITeeExtensionRegistry.TeeInstructionParams({
                opType: opType,
                opCommand: command,
                message: message,
                cosigners: cosigners,
                cosignersThreshold: 0,
                claimBackAddress: msg.sender
            })
        );
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return address(0);
        signer = ecrecover(digest, v, r, s);
    }
}
