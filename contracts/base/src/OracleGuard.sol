// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IOracleGuard } from "./IOracleGuard.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

interface ISequencerUptimeFeed {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

interface IOracleRegistry {
    function getOracleParams(address asset) external view returns (uint256 multiplier, bool paused);
}

contract OracleGuard is IOracleGuard {
    struct FeedConfig {
        address feed;
        uint256 heartbeat;
    }

    struct FeedObservation {
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        uint8 decimals;
        uint80 answeredInRound;
    }

    struct SequencerObservation {
        uint80 roundId;
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    address public admin;
    address public immutable sequencerFeed;
    address public immutable oracleRegistry;
    uint256 public gracePeriod;
    mapping(address => FeedConfig) public feedConfigs;

    event FeedConfigured(address indexed asset, address indexed feed, uint256 heartbeat);
    event GracePeriodUpdated(uint256 gracePeriod);

    modifier onlyAdmin() {
        require(msg.sender == admin, "UNAUTHORIZED");
        _;
    }

    constructor(address sequencerFeed_, address oracleRegistry_, uint256 gracePeriod_) {
        require(sequencerFeed_ != address(0), "INVALID_SEQUENCER_FEED");
        require(oracleRegistry_ != address(0), "INVALID_ORACLE_REGISTRY");
        require(gracePeriod_ != 0, "INVALID_GRACE_PERIOD");
        admin = msg.sender;
        sequencerFeed = sequencerFeed_;
        oracleRegistry = oracleRegistry_;
        gracePeriod = gracePeriod_;
    }

    function configureFeed(address asset, address feed, uint256 heartbeat) external onlyAdmin {
        require(asset != address(0), "INVALID_ASSET");
        require(feed != address(0), "INVALID_FEED");
        require(heartbeat != 0, "INVALID_HEARTBEAT");
        feedConfigs[asset] = FeedConfig({ feed: feed, heartbeat: heartbeat });
        emit FeedConfigured(asset, feed, heartbeat);
    }

    function setGracePeriod(uint256 gracePeriod_) external onlyAdmin {
        require(gracePeriod_ != 0, "INVALID_GRACE_PERIOD");
        gracePeriod = gracePeriod_;
        emit GracePeriodUpdated(gracePeriod_);
    }

    function snapshot(address asset)
        external
        view
        returns (
            int256 answer,
            uint256 updatedAt,
            uint8 decimals,
            bool sequencerUp,
            uint256 sequencerStartedAt,
            bool registryPaused
        )
    {
        FeedConfig memory config = _configuredFeed(asset);
        FeedObservation memory feed = _readFeed(config.feed);
        SequencerObservation memory sequencer = _readSequencer();
        (, registryPaused) = IOracleRegistry(oracleRegistry).getOracleParams(asset);
        return (
            feed.answer,
            feed.updatedAt,
            feed.decimals,
            sequencer.answer == 0,
            sequencer.startedAt,
            registryPaused
        );
    }

    function requireFresh(address asset) external view {
        FeedConfig memory config = _configuredFeed(asset);
        FeedObservation memory feed = _readFeed(config.feed);
        _validateFeed(feed, config.heartbeat);

        SequencerObservation memory sequencer = _readSequencer();
        _validateSequencer(sequencer);

        (uint256 multiplier, bool paused) = IOracleRegistry(oracleRegistry).getOracleParams(asset);
        require(multiplier != 0, "REGISTRY_MULTIPLIER");
        require(!paused, "REGISTRY_PAUSED");
    }

    function _configuredFeed(address asset) internal view returns (FeedConfig memory config) {
        config = feedConfigs[asset];
        require(config.feed != address(0) && config.heartbeat != 0, "ASSET_NOT_CONFIGURED");
    }

    function _readFeed(address feed) internal view returns (FeedObservation memory observation) {
        observation.decimals = IAggregatorV3(feed).decimals();
        (
            observation.roundId,
            observation.answer,,
            observation.updatedAt,
            observation.answeredInRound
        ) = IAggregatorV3(feed).latestRoundData();
    }

    function _readSequencer() internal view returns (SequencerObservation memory observation) {
        (
            observation.roundId,
            observation.answer,
            observation.startedAt,
            observation.updatedAt,
            observation.answeredInRound
        ) = ISequencerUptimeFeed(sequencerFeed).latestRoundData();
    }

    function _validateFeed(FeedObservation memory observation, uint256 heartbeat) internal view {
        require(observation.decimals == 8, "ORACLE_DECIMALS");
        require(
            observation.roundId != 0 && observation.answeredInRound >= observation.roundId
                && observation.updatedAt != 0,
            "ORACLE_INCOMPLETE"
        );
        require(observation.updatedAt <= block.timestamp, "ORACLE_FUTURE");
        require(observation.answer > 0, "ORACLE_NON_POSITIVE");
        require(block.timestamp - observation.updatedAt <= heartbeat, "ORACLE_STALE");
    }

    function _validateSequencer(SequencerObservation memory observation) internal view {
        require(
            observation.roundId != 0 && observation.answeredInRound >= observation.roundId,
            "SEQUENCER_INVALID"
        );
        require(
            observation.startedAt != 0 && observation.updatedAt != 0, "SEQUENCER_INVALID_TIMESTAMP"
        );
        require(
            observation.startedAt <= block.timestamp && observation.updatedAt <= block.timestamp,
            "SEQUENCER_FUTURE"
        );
        require(observation.startedAt <= observation.updatedAt, "SEQUENCER_INVALID_TIMESTAMP");
        if (observation.answer == 1) revert("SEQUENCER_DOWN");
        require(observation.answer == 0, "SEQUENCER_INVALID");
        require(block.timestamp - observation.startedAt > gracePeriod, "SEQUENCER_GRACE");
    }
}
