// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IFacilityAdapter } from "../src/IFacilityAdapter.sol";
import { IERC20 } from "../src/IERC20.sol";

contract MockFacilityAdapter is IFacilityAdapter {
    address public immutable asset;
    uint256 public withdrawLimit = type(uint256).max;

    constructor(address asset_) {
        asset = asset_;
    }

    function deposit(uint256 assets) external returns (uint256 deployed) {
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED"
        );
        return assets;
    }

    function withdraw(uint256 assets, address receiver) external returns (uint256 returned) {
        require(assets <= maxWithdraw(), "ILLIQUID");
        require(IERC20(asset).transfer(receiver, assets), "ASSET_TRANSFER_FAILED");
        return assets;
    }

    function totalAssets() external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function maxWithdraw() public view returns (uint256) {
        uint256 balance = IERC20(asset).balanceOf(address(this));
        return balance < withdrawLimit ? balance : withdrawLimit;
    }

    function setWithdrawLimit(uint256 limit) external {
        withdrawLimit = limit;
    }
}
