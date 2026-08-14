// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {ConfidentialRFQInstructionSender, ITeeExtensionRegistry} from "../src/ConfidentialRFQInstructionSender.sol";

contract MockTeeMachineRegistryForTest {
    address[] private teeIds;

    constructor(address[] memory teeIds_) {
        teeIds = teeIds_;
    }

    function getRandomTeeIds(uint256, uint256 count) external view returns (address[] memory selected) {
        require(count == teeIds.length, "COUNT");
        return teeIds;
    }
}

contract MockTeeExtensionRegistryForTest {
    bytes32 public lastOpType;
    bytes32 public lastCommand;
    bytes public lastMessage;
    uint256 public lastTeeCount;
    uint64 public lastThreshold;

    function sendInstructions(
        address[] calldata teeIds,
        ITeeExtensionRegistry.TeeInstructionParams calldata params
    ) external payable returns (bytes32 instructionId) {
        lastOpType = params.opType;
        lastCommand = params.opCommand;
        lastMessage = params.message;
        lastTeeCount = teeIds.length;
        lastThreshold = params.cosignersThreshold;
        return bytes32(uint256(123));
    }
}

contract InstructionSenderTest is TestBase {
    ConfidentialRFQInstructionSender private sender;
    address private teeA = address(0xA);
    address private teeB = address(0xB);
    address private teeC = address(0xC);
    address private teeD = address(0xD);

    function setUp() public {
        sender = new ConfidentialRFQInstructionSender();
        sender.registerTEE(teeA);
        sender.registerTEE(teeB);
        sender.registerTEE(teeC);
        sender.registerTEE(teeD);
    }

    function testTwoMatchingAttestedResultsMakeACommitmentExecutable() public {
        bytes32 action = bytes32(uint256(1));
        bytes32 result = bytes32(uint256(2));
        vm.prank(teeA);
        sender.submitResult(action, result, true);
        vm.prank(teeB);
        sender.submitResult(action, result, true);
        (bool ready, bytes32 selected) = sender.quorum(action);
        assertTrue(ready);
        assertTrue(selected == result);
    }

    function testSplitBrainAndUnknownOperationsFailClosed() public {
        bytes32 action = bytes32(uint256(3));
        vm.prank(teeA);
        sender.submitResult(action, bytes32(uint256(4)), true);
        vm.prank(teeB);
        sender.submitResult(action, bytes32(uint256(5)), true);
        (bool ready,) = sender.quorum(action);
        assertTrue(!ready);
        vm.expectRevert(bytes("OP_NOT_ALLOWED"));
        sender.dispatch(bytes32("UNKNOWN"), bytes32("UNKNOWN"), bytes32(uint256(1)), bytes32(uint256(2)), 100);
    }

    function testRejectsZeroActionAndResultReferences() public {
        vm.expectRevert(bytes("RESULT_SCHEMA"));
        vm.prank(teeA);
        sender.submitResult(bytes32(uint256(1)), bytes32(0), true);
        bytes32 opType = sender.OP_RFQ();
        bytes32 command = sender.COMMAND_CREATE();
        vm.expectRevert(bytes("ACTION_REQUIRED"));
        sender.dispatch(opType, command, bytes32(0), bytes32(uint256(2)), uint64(block.timestamp + 1));
    }

    function testQuorumSelectionIsDeterministicWhenMultipleHashesReachThreshold() public {
        bytes32 action = bytes32(uint256(4));
        vm.prank(teeA);
        sender.submitResult(action, bytes32(uint256(10)), true);
        vm.prank(teeB);
        sender.submitResult(action, bytes32(uint256(10)), true);
        vm.prank(teeC);
        sender.submitResult(action, bytes32(uint256(1)), true);
        vm.prank(teeD);
        sender.submitResult(action, bytes32(uint256(1)), true);

        (bool ready, bytes32 selected) = sender.quorum(action);
        assertTrue(ready);
        assertTrue(selected == bytes32(uint256(1)));
    }

    function testConfiguredFccDispatchRoutesToMachineRegistryAndBlocksSimulationDowngrade() public {
        address[] memory teeIds = new address[](3);
        teeIds[0] = teeA;
        teeIds[1] = teeB;
        teeIds[2] = teeC;
        MockTeeMachineRegistryForTest machineRegistry = new MockTeeMachineRegistryForTest(teeIds);
        MockTeeExtensionRegistryForTest extensionRegistry = new MockTeeExtensionRegistryForTest();
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 65536, 2);

        bytes32 action = bytes32(uint256(8));
        bytes memory message = hex"1234";
        bytes32 payload = keccak256(message);
        bytes32 instructionId = sender.dispatchConfidential{value: 1 ether}(
            sender.OP_RFQ(), sender.COMMAND_CREATE(), action, payload, message, 3, uint64(block.timestamp + 1 hours)
        );
        assertTrue(instructionId == bytes32(uint256(123)));
        assertTrue(extensionRegistry.lastOpType() == sender.OP_RFQ());
        assertTrue(extensionRegistry.lastCommand() == sender.COMMAND_CREATE());
        assertTrue(extensionRegistry.lastTeeCount() == 3);
        assertTrue(extensionRegistry.lastThreshold() == 0);
        (bool simulatedDispatchOk,) = address(sender).call(abi.encodeWithSignature(
            "dispatch(bytes32,bytes32,bytes32,bytes32,uint64)",
            sender.OP_RFQ(), sender.COMMAND_CREATE(), action, payload, uint64(block.timestamp + 1)
        ));
        assertTrue(!simulatedDispatchOk);
        (bool simulatedRegistrationOk,) = address(sender).call(abi.encodeWithSignature("registerTEE(address)", teeD));
        assertTrue(!simulatedRegistrationOk);
    }

    function testConfiguredFccRequiresExactlyTwoOfThree() public {
        address[] memory teeIds = new address[](3);
        teeIds[0] = teeA;
        teeIds[1] = teeB;
        teeIds[2] = teeC;
        MockTeeMachineRegistryForTest machineRegistry = new MockTeeMachineRegistryForTest(teeIds);
        MockTeeExtensionRegistryForTest extensionRegistry = new MockTeeExtensionRegistryForTest();

        vm.expectRevert(bytes("FCC_QUORUM_REQUIRED"));
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 65536, 3);
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 65536, 2);

        bytes32 opType = sender.OP_RFQ();
        bytes32 command = sender.COMMAND_CREATE();
        vm.expectRevert(bytes("FCC_TEE_COUNT"));
        sender.dispatchConfidential(
            opType, command, bytes32(uint256(1)), keccak256(hex"1234"), hex"1234", 4, uint64(block.timestamp + 1 hours)
        );
    }

    function testConfiguredFccRejectsInvalidExtensionAndDuplicateTeeSelection() public {
        address[] memory teeIds = new address[](3);
        teeIds[0] = teeA;
        teeIds[1] = teeA;
        teeIds[2] = teeC;
        MockTeeMachineRegistryForTest machineRegistry = new MockTeeMachineRegistryForTest(teeIds);
        MockTeeExtensionRegistryForTest extensionRegistry = new MockTeeExtensionRegistryForTest();

        vm.expectRevert(bytes("FCC_EXTENSION_ID"));
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 1, 2);
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 65536, 2);

        bytes32 opType = sender.OP_RFQ();
        bytes32 command = sender.COMMAND_CREATE();
        vm.expectRevert(bytes("FCC_TEE_SELECTION"));
        sender.dispatchConfidential(
            opType, command, bytes32(uint256(1)), keccak256(hex"1234"), hex"1234", 3, uint64(block.timestamp + 1 hours)
        );
    }

    function testConfiguredFccIsImmutableAndBindsMessageCommitmentAndDeadline() public {
        address[] memory teeIds = new address[](3);
        teeIds[0] = teeA;
        teeIds[1] = teeB;
        teeIds[2] = teeC;
        MockTeeMachineRegistryForTest machineRegistry = new MockTeeMachineRegistryForTest(teeIds);
        MockTeeExtensionRegistryForTest extensionRegistry = new MockTeeExtensionRegistryForTest();
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 65536, 2);

        vm.expectRevert(bytes("FCC_ALREADY_CONFIGURED"));
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 65537, 2);

        bytes32 opType = sender.OP_RFQ();
        bytes32 command = sender.COMMAND_CREATE();
        vm.expectRevert(bytes("COMMITMENT_MISMATCH"));
        sender.dispatchConfidential(
            opType, command, bytes32(uint256(20)), bytes32(uint256(21)), hex"1234", 3,
            uint64(block.timestamp + 1 hours)
        );

        vm.expectRevert(bytes("INSTRUCTION_EXPIRED"));
        sender.dispatchConfidential(
            opType, command, bytes32(uint256(20)), keccak256(hex"1234"), hex"1234", 3,
            uint64(block.timestamp - 1)
        );
    }

    function testRealFccResultRequiresSelectedTeeSignatureAndTwoMatchingResults() public {
        uint256 teeAPrivateKey = 0xA11CE;
        uint256 teeBPrivateKey = 0xB0B;
        uint256 teeDPrivateKey = 0xD00D;
        teeA = vm.addr(teeAPrivateKey);
        teeB = vm.addr(teeBPrivateKey);
        teeC = address(0xC);
        address[] memory teeIds = new address[](3);
        teeIds[0] = teeA;
        teeIds[1] = teeB;
        teeIds[2] = teeC;
        MockTeeMachineRegistryForTest machineRegistry = new MockTeeMachineRegistryForTest(teeIds);
        MockTeeExtensionRegistryForTest extensionRegistry = new MockTeeExtensionRegistryForTest();
        sender.configureFcc(address(extensionRegistry), address(machineRegistry), 65536, 2);

        bytes32 action = bytes32(uint256(30));
        bytes memory message = hex"1234";
        bytes32 instructionId = sender.dispatchConfidential(
            sender.OP_MATCH(), sender.COMMAND_FINALIZE(), action, keccak256(message), message, 3,
            uint64(block.timestamp + 1 hours)
        );
        bytes32 routeHash = keccak256("route");
        bytes memory resultData = abi.encode(routeHash);
        string memory submissionTag = "trust-rfq";

        bytes memory wrongSignature = _signActionResult(teeDPrivateKey, instructionId, resultData, submissionTag, 1);
        vm.expectRevert(bytes("TEE_NOT_SELECTED"));
        sender.submitFccResult(instructionId, resultData, submissionTag, 1, wrongSignature);

        bytes memory teeASignature = _signActionResult(teeAPrivateKey, instructionId, resultData, submissionTag, 1);
        sender.submitFccResult(instructionId, resultData, submissionTag, 1, teeASignature);
        (bool oneReady,) = sender.quorum(action);
        assertTrue(!oneReady);
        bytes memory teeBSignature = _signActionResult(teeBPrivateKey, instructionId, resultData, submissionTag, 1);
        sender.submitFccResult(instructionId, resultData, submissionTag, 1, teeBSignature);
        (bool ready, bytes32 selected) = sender.quorum(action);
        assertTrue(ready);
        assertTrue(selected == routeHash);
    }

    function _signActionResult(
        uint256 privateKey,
        bytes32 actionId,
        bytes memory resultData,
        string memory submissionTag,
        uint8 status
    ) private returns (bytes memory) {
        bytes32 actionResultHash = keccak256(
            abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(submissionTag)), status)
        );
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), block.chainid, actionResultHash));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSignedHash);
        return abi.encodePacked(r, s, v);
    }

    function testAllowsTypedLiquidationOperations() public {
        sender.dispatch(
            sender.OP_LIQUIDATION(), sender.COMMAND_CREATE(), bytes32(uint256(10)), bytes32(uint256(11)), uint64(block.timestamp + 1)
        );
        sender.dispatch(
            sender.OP_LIQUIDATION(), sender.COMMAND_FINALIZE(), bytes32(uint256(12)), bytes32(uint256(13)), uint64(block.timestamp + 1)
        );
    }
}
