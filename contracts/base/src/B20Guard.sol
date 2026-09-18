// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IB20Guard } from "./IB20Guard.sol";

interface IB20PolicyToken {
    function pausedFeatures() external view returns (uint8[] memory);

    function TRANSFER_SENDER_POLICY() external view returns (bytes32);

    function TRANSFER_RECEIVER_POLICY() external view returns (bytes32);

    function policyId(bytes32 scope) external view returns (uint64);

    function WAD_PRECISION() external view returns (uint256);

    function multiplier() external view returns (uint256);

    function scaledBalanceOf(address account) external view returns (uint256);
}

interface IPolicyRegistry {
    function isAuthorized(uint64 policyId, address account) external view returns (bool);
}

contract B20Guard is IB20Guard {
    uint8 private constant TRANSFER = 0;
    uint8 private constant SEIZE = 3;
    uint256 private constant WAD = 1e18;

    address public admin;
    address public immutable policyRegistry;

    modifier onlyAdmin() {
        require(msg.sender == admin, "UNAUTHORIZED");
        _;
    }

    constructor(address policyRegistry_) {
        require(policyRegistry_ != address(0), "INVALID_POLICY_REGISTRY");
        admin = msg.sender;
        policyRegistry = policyRegistry_;
    }

    function requireTransferAndSeizeLive(address token) external view {
        require(token != address(0), "INVALID_TOKEN");
        uint8[] memory paused = IB20PolicyToken(token).pausedFeatures();
        for (uint256 i; i < paused.length; ++i) {
            if (paused[i] == TRANSFER) revert("TRANSFER_PAUSED");
            if (paused[i] == SEIZE) revert("SEIZE_PAUSED");
        }
    }

    function requireTransferAuthorized(address token, address sender, address recipient)
        external
        view
    {
        require(token != address(0), "INVALID_TOKEN");
        require(sender != address(0) && recipient != address(0), "INVALID_ACCOUNT");

        bytes32 senderScope = IB20PolicyToken(token).TRANSFER_SENDER_POLICY();
        bytes32 recipientScope = IB20PolicyToken(token).TRANSFER_RECEIVER_POLICY();
        uint64 senderPolicy = IB20PolicyToken(token).policyId(senderScope);
        uint64 recipientPolicy = IB20PolicyToken(token).policyId(recipientScope);
        require(
            IPolicyRegistry(policyRegistry).isAuthorized(senderPolicy, sender),
            "TRANSFER_SENDER_UNAUTHORIZED"
        );
        require(
            IPolicyRegistry(policyRegistry).isAuthorized(recipientPolicy, recipient),
            "TRANSFER_RECEIVER_UNAUTHORIZED"
        );
    }

    function multiplierWad(address token) external view returns (uint256) {
        require(token != address(0), "INVALID_TOKEN");
        require(IB20PolicyToken(token).WAD_PRECISION() == WAD, "INVALID_WAD_PRECISION");
        uint256 multiplier = IB20PolicyToken(token).multiplier();
        require(multiplier != 0, "INVALID_MULTIPLIER");
        return multiplier;
    }

    function scaledBalanceOf(address token, address account) external view returns (uint256) {
        require(token != address(0), "INVALID_TOKEN");
        require(account != address(0), "INVALID_ACCOUNT");
        return IB20PolicyToken(token).scaledBalanceOf(account);
    }
}
