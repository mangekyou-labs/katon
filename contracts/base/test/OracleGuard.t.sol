// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IOracleGuard } from "../src/IOracleGuard.sol";
import { OracleGuard } from "../src/OracleGuard.sol";
import { TestBase } from "./TestBase.sol";

contract MockOracleFeed {
    uint80 public roundId = 1;
    int256 public answer = 100_000_000;
    uint256 public startedAt = 999_900;
    uint256 public updatedAt = 999_900;
    uint80 public answeredInRound = 1;
    uint8 public feedDecimals = 8;
    bool public revertOnRead;

    function setRound(uint80 roundId_, int256 answer_, uint256 updatedAt_, uint80 answeredInRound_)
        external
    {
        roundId = roundId_;
        answer = answer_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function setDecimals(uint8 decimals_) external {
        feedDecimals = decimals_;
    }

    function setRevertOnRead(bool value) external {
        revertOnRead = value;
    }

    function decimals() external view returns (uint8) {
        if (revertOnRead) revert("FEED_REVERT");
        return feedDecimals;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (revertOnRead) revert("FEED_REVERT");
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

contract MockSequencerFeed {
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt = 999_900;
    uint256 public updatedAt = 999_900;
    uint80 public answeredInRound = 1;
    bool public revertOnRead;

    function setStatus(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function setRevertOnRead(bool value) external {
        revertOnRead = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (revertOnRead) revert("SEQUENCER_REVERT");
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

contract MockOracleRegistry {
    uint256 public registryMultiplier = 1e18;
    bool public registryPaused;
    bool public revertOnRead;

    function setParams(uint256 multiplier_, bool paused_) external {
        registryMultiplier = multiplier_;
        registryPaused = paused_;
    }

    function setRevertOnRead(bool value) external {
        revertOnRead = value;
    }

    function getOracleParams(address) external view returns (uint256 multiplier, bool paused) {
        if (revertOnRead) revert("REGISTRY_REVERT");
        return (registryMultiplier, registryPaused);
    }
}

contract OracleGuardTest is TestBase {
    uint256 internal constant GRACE_PERIOD = 3_600;
    uint256 internal constant HEARTBEAT = 86_400;
    uint256 internal constant NOW = 1_000_000;

    address internal constant ASSET = address(0xA551);

    MockOracleFeed internal feed;
    MockSequencerFeed internal sequencer;
    MockOracleRegistry internal registry;
    OracleGuard internal guard;

    function setUp() public {
        vm.warp(NOW);
        feed = new MockOracleFeed();
        sequencer = new MockSequencerFeed();
        registry = new MockOracleRegistry();
        sequencer.setStatus(0, NOW - GRACE_PERIOD - 100, NOW - GRACE_PERIOD - 100);
        feed.setRound(1, 100_000_000, NOW - 100, 1);
        guard = new OracleGuard(address(sequencer), address(registry), GRACE_PERIOD);
        guard.configureFeed(ASSET, address(feed), HEARTBEAT);
    }

    function testFreshRoundAndSnapshot() public view {
        guard.requireFresh(ASSET);
        (int256 answer, uint256 updatedAt, uint8 decimals, bool sequencerUp,, bool registryPaused) =
            guard.snapshot(ASSET);
        assertEq(uint256(uint256(answer)), 100_000_000);
        assertEq(updatedAt, NOW - 100);
        assertEq(uint256(decimals), 8);
        assertTrue(sequencerUp);
        assertTrue(!registryPaused);
    }

    function testRejectsStaleFutureZeroNegativeAndIncompleteRounds() public {
        feed.setRound(1, 100_000_000, NOW - HEARTBEAT - 1, 1);
        vm.expectRevert(bytes("ORACLE_STALE"));
        guard.requireFresh(ASSET);

        feed.setRound(1, 100_000_000, NOW + 1, 1);
        vm.expectRevert(bytes("ORACLE_FUTURE"));
        guard.requireFresh(ASSET);

        feed.setRound(0, 100_000_000, NOW - 100, 0);
        vm.expectRevert(bytes("ORACLE_INCOMPLETE"));
        guard.requireFresh(ASSET);

        feed.setRound(1, 0, NOW - 100, 1);
        vm.expectRevert(bytes("ORACLE_NON_POSITIVE"));
        guard.requireFresh(ASSET);

        feed.setRound(1, -1, NOW - 100, 1);
        vm.expectRevert(bytes("ORACLE_NON_POSITIVE"));
        guard.requireFresh(ASSET);

        feed.setRound(1, 100_000_000, NOW - 100, 0);
        vm.expectRevert(bytes("ORACLE_INCOMPLETE"));
        guard.requireFresh(ASSET);
    }

    function testRejectsWrongDecimalsAndRegistryState() public {
        feed.setDecimals(18);
        vm.expectRevert(bytes("ORACLE_DECIMALS"));
        guard.requireFresh(ASSET);

        feed.setDecimals(8);
        registry.setParams(0, false);
        vm.expectRevert(bytes("REGISTRY_MULTIPLIER"));
        guard.requireFresh(ASSET);

        registry.setParams(1e18, true);
        vm.expectRevert(bytes("REGISTRY_PAUSED"));
        guard.requireFresh(ASSET);
    }

    function testRejectsSequencerDownInvalidTimestampsAndRecoveryGrace() public {
        sequencer.setStatus(1, NOW - 100, NOW - 100);
        vm.expectRevert(bytes("SEQUENCER_DOWN"));
        guard.requireFresh(ASSET);

        sequencer.setStatus(2, NOW - 100, NOW - 100);
        vm.expectRevert(bytes("SEQUENCER_INVALID"));
        guard.requireFresh(ASSET);

        sequencer.setStatus(0, NOW - 100, NOW + 1);
        vm.expectRevert(bytes("SEQUENCER_FUTURE"));
        guard.requireFresh(ASSET);

        sequencer.setStatus(0, 0, NOW - 100);
        vm.expectRevert(bytes("SEQUENCER_INVALID_TIMESTAMP"));
        guard.requireFresh(ASSET);

        sequencer.setStatus(0, NOW - 100, 0);
        vm.expectRevert(bytes("SEQUENCER_INVALID_TIMESTAMP"));
        guard.requireFresh(ASSET);

        sequencer.setStatus(0, NOW - 100, NOW - 100);
        guard.setGracePeriod(100);
        vm.expectRevert(bytes("SEQUENCER_GRACE"));
        guard.requireFresh(ASSET);
    }

    function testRejectsUnconfiguredAndInvalidConfiguration() public {
        vm.expectRevert(bytes("ASSET_NOT_CONFIGURED"));
        guard.requireFresh(address(0xBEEF));

        vm.expectRevert(bytes("INVALID_ASSET"));
        guard.configureFeed(address(0), address(feed), HEARTBEAT);

        vm.expectRevert(bytes("INVALID_FEED"));
        guard.configureFeed(address(0xBEEF), address(0), HEARTBEAT);

        vm.expectRevert(bytes("INVALID_HEARTBEAT"));
        guard.configureFeed(address(0xBEEF), address(feed), 0);

        vm.expectRevert(bytes("INVALID_GRACE_PERIOD"));
        guard.setGracePeriod(0);
    }

    function testDependencyRevertsFailClosed() public {
        feed.setRevertOnRead(true);
        vm.expectRevert(bytes("FEED_REVERT"));
        guard.requireFresh(ASSET);

        feed.setRevertOnRead(false);
        sequencer.setRevertOnRead(true);
        vm.expectRevert(bytes("SEQUENCER_REVERT"));
        guard.requireFresh(ASSET);

        sequencer.setRevertOnRead(false);
        registry.setRevertOnRead(true);
        vm.expectRevert(bytes("REGISTRY_REVERT"));
        guard.requireFresh(ASSET);
    }
}
