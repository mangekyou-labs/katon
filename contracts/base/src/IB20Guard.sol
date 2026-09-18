// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IB20Guard {
    function requireTransferAndSeizeLive(address token) external view;

    function requireTransferAuthorized(address token, address sender, address recipient)
        external
        view;

    function multiplierWad(address token) external view returns (uint256);

    function scaledBalanceOf(address token, address account) external view returns (uint256);
}
