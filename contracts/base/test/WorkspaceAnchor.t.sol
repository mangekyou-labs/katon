// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { TestBase } from "./TestBase.sol";
import { WorkspaceAnchor } from "../src/WorkspaceAnchor.sol";

contract WorkspaceAnchorTest is TestBase {
    function testAnchorIsAvailable() external {
        assertTrue(new WorkspaceAnchor().anchored());
    }
}
