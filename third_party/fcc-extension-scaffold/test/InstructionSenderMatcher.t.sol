// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {HelloWorldInstructionSender} from "../contracts/InstructionSender.sol";
import {ITeeExtensionRegistry} from "../contracts/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../contracts/interfaces/ITeeMachineRegistry.sol";

contract Asserts {
    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "ASSERT_EQ_BYTES32");
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        require(left == right, "ASSERT_EQ_UINT");
    }

    function assertEq(bytes memory left, bytes memory right) internal pure {
        require(keccak256(left) == keccak256(right), "ASSERT_EQ_BYTES");
    }
}

contract MockTeeMachineRegistry is ITeeMachineRegistry {
    address[] private teeIds;

    constructor(address tee) {
        teeIds = new address[](1);
        teeIds[0] = tee;
    }

    function getRandomTeeIds(uint256, uint256 count) external view returns (address[] memory) {
        require(count == 1, "COUNT");
        return teeIds;
    }
}

contract MockTeeExtensionRegistry is ITeeExtensionRegistry {
    address public sender;
    bytes32 public lastOpType;
    bytes32 public lastOpCommand;
    bytes public lastMessage;
    uint256 public sendCount;

    function setSender(address sender_) external {
        sender = sender_;
    }

    function sendInstructions(address[] calldata, TeeInstructionParams calldata params)
        external
        payable
        returns (bytes32)
    {
        lastOpType = params.opType;
        lastOpCommand = params.opCommand;
        lastMessage = params.message;
        sendCount += 1;
        return bytes32(uint256(0xabc));
    }

    function nextPublicExtensionId() external pure returns (uint256) {
        return 65537;
    }

    function getTeeExtensionInstructionsSender(uint256 extensionId) external view returns (address) {
        if (extensionId == 65536) return sender;
        return address(0);
    }
}

contract InstructionSenderMatcherTest is Asserts {
    HelloWorldInstructionSender private sender;
    MockTeeExtensionRegistry private extReg;
    MockTeeMachineRegistry private machineReg;

    function setUp() public {
        extReg = new MockTeeExtensionRegistry();
        machineReg = new MockTeeMachineRegistry(address(0xBEE));
        sender = new HelloWorldInstructionSender(
            ITeeExtensionRegistry(address(extReg)),
            ITeeMachineRegistry(address(machineReg))
        );
        extReg.setSender(address(sender));
        sender.setExtensionId();
    }

    function testSendRFQCreateForwardsRFQCreateBytes32s() public {
        bytes memory message = bytes('{"commitment":"0x11"}');
        sender.sendRFQCreate(message);
        assertEq(extReg.lastOpType(), bytes32("RFQ"));
        assertEq(extReg.lastOpCommand(), bytes32("CREATE"));
        assertEq(extReg.lastMessage(), message);
        assertEq(extReg.sendCount(), 1);
    }

    function testSendBidSubmitForwardsBIDSubmitBytes32s() public {
        bytes memory message = bytes('{"commitment":"0x99"}');
        sender.sendBidSubmit(message);
        assertEq(extReg.lastOpType(), bytes32("BID"));
        assertEq(extReg.lastOpCommand(), bytes32("SUBMIT"));
        assertEq(extReg.lastMessage(), message);
    }

    function testSendMatchFinalizeForwardsMATCHFinalizeBytes32s() public {
        bytes memory message = bytes('{"auction":{}}');
        sender.sendMatchFinalize(message);
        assertEq(extReg.lastOpType(), bytes32("MATCH"));
        assertEq(extReg.lastOpCommand(), bytes32("FINALIZE"));
        assertEq(extReg.lastMessage(), message);
    }

    function testMatcherOpConstantsMatchGoShortStrings() public view {
        assertEq(sender.OP_TYPE_RFQ(), bytes32("RFQ"));
        assertEq(sender.OP_TYPE_BID(), bytes32("BID"));
        assertEq(sender.OP_TYPE_MATCH(), bytes32("MATCH"));
        assertEq(sender.OP_COMMAND_CREATE(), bytes32("CREATE"));
        assertEq(sender.OP_COMMAND_SUBMIT(), bytes32("SUBMIT"));
        assertEq(sender.OP_COMMAND_FINALIZE(), bytes32("FINALIZE"));
    }
}
