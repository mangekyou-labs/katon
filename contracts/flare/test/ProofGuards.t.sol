// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {NavProofRegistry, FtsoRiskGuard} from "../src/ProofGuards.sol";

contract ProofGuardsTest is TestBase {
    address private owner = address(0xA11CE);
    address private asset = address(0xBEEF);

    function testNavProofIsMonotonicAndSingleUse() public {
        NavProofRegistry registry = new NavProofRegistry();
        vm.prank(owner);
        registry.submit(asset, bytes32(uint256(1)), 123_456, 2, 100, 200, owner, true);
        (uint256 value,, uint64 asOf,) = registry.latest(asset);
        assertEq(value, 123_456);
        assertEq(asOf, 100);

        vm.expectRevert(bytes("PROOF_REPLAY"));
        vm.prank(owner);
        registry.submit(asset, bytes32(uint256(1)), 123_456, 2, 101, 200, owner, true);
        vm.expectRevert(bytes("NAV_NOT_MONOTONIC"));
        vm.prank(owner);
        registry.submit(asset, bytes32(uint256(2)), 123_456, 2, 100, 200, owner, true);
        vm.expectRevert(bytes("PROOF_OWNER"));
        vm.prank(address(0xCAFE));
        registry.submit(asset, bytes32(uint256(3)), 123_456, 2, 101, 200, owner, true);
    }

    function testFtsoGuardRejectsStaleAndDeviation() public {
        FtsoRiskGuard guard = new FtsoRiskGuard();
        bytes32 feedId = bytes32("USDX/USD");
        guard.configure(feedId, 100, 50);
        vm.warp(1_000);
        assertEq(guard.assertUsable(feedId, 1_000_000, -6, 950, 1_000_000, -6), 1 ether);
        vm.expectRevert(bytes("FTSO_STALE"));
        guard.assertUsable(feedId, 1_000_000, -6, 899, 1_000_000, -6);
        vm.expectRevert(bytes("FTSO_DEVIATION"));
        guard.assertUsable(feedId, 990_000, -6, 950, 1_000_000, -6);
    }

    function testProofAndFeedSchemasRejectMalformedIdentifiersAndDecimals() public {
        NavProofRegistry registry = new NavProofRegistry();
        vm.expectRevert(bytes("PROOF_SCHEMA"));
        registry.submit(address(0), bytes32(0), 1, 37, 100, 200, address(this), true);

        FtsoRiskGuard guard = new FtsoRiskGuard();
        vm.expectRevert(bytes("FTSO_FEED_REQUIRED"));
        guard.configure(bytes32(0), 100, 50);
        bytes32 feedId = bytes32("USDX/USD");
        guard.configure(feedId, 100, 50);
        vm.expectRevert(bytes("FTSO_DECIMALS"));
        guard.assertUsable(feedId, 1, -37, 950, 1, -6);
    }
}
