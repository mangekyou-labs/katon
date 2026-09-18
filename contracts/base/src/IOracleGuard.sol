// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IOracleGuard {
    function configureFeed(address asset, address feed, uint256 heartbeat) external;

    function setGracePeriod(uint256 gracePeriod) external;

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
        );

    function requireFresh(address asset) external view;
}
