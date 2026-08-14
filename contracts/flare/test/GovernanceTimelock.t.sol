// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GovernanceTimelock} from "../src/GovernanceTimelock.sol";
import {TestBase} from "./TestBase.sol";

contract TimelockTarget {
    uint256 public value;
    function setValue(uint256 value_) external { value = value_; }
}

contract GovernanceTimelockTest is TestBase {
    function testRequiresDelayAndOnlyExecutorCanExecute() public {
        address proposer = address(0xA11CE);
        address executor = address(0xB0B);
        GovernanceTimelock timelock = new GovernanceTimelock(2 days, proposer, executor);
        TimelockTarget target = new TimelockTarget();
        bytes memory data = abi.encodeCall(TimelockTarget.setValue, (42));
        bytes32 salt = keccak256("set-42");

        vm.prank(proposer);
        bytes32 id = timelock.schedule(address(target), 0, data, bytes32(0), salt);
        vm.expectRevert("TIMELOCK_NOT_READY");
        vm.prank(executor);
        timelock.execute(address(target), 0, data, bytes32(0), salt);

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert("TIMELOCK_EXECUTOR");
        timelock.execute(address(target), 0, data, bytes32(0), salt);
        vm.prank(executor);
        timelock.execute(address(target), 0, data, bytes32(0), salt);
        assertEq(target.value(), 42);
        assertEq(timelock.scheduled(id), 0);
        assertTrue(timelock.completed(id));
    }
}
