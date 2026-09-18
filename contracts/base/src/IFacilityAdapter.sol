// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFacilityAdapter {
    function asset() external view returns (address);

    function deposit(uint256 assets) external returns (uint256 deployed);

    function withdraw(uint256 assets, address receiver) external returns (uint256 returned);

    function totalAssets() external view returns (uint256);

    function maxWithdraw() external view returns (uint256);
}
