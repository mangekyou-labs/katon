// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseYieldAdapter, IERC20YieldAdapter} from "./BaseYieldAdapter.sol";

interface IMorphoVaultV2 {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function maxWithdraw(address owner) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
}

/// @dev Morpho-style yield adapter for a single governance-fixed market/vault.
contract MorphoYieldAdapter is BaseYieldAdapter {
    address public immutable vault;

    constructor(address facility_, address asset_, address vault_, bytes32 marketId_)
        BaseYieldAdapter(facility_, asset_, marketId_)
    {
        require(vault_ != address(0), "VAULT");
        vault = vault_;
    }

    function deposit(uint256 assets) external onlyFacility whenNotPaused returns (uint256 deployed) {
        require(assets > 0, "AMOUNT");
        require(IERC20YieldAdapter(asset).balanceOf(address(this)) >= assets, "BALANCE");
        _approve(vault, assets);
        uint256 shares = IMorphoVaultV2(vault).deposit(assets, address(this));
        require(shares > 0, "MORPHO_SHARES");
        _approve(vault, 0);
        deployed = assets;
    }

    function withdraw(uint256 assets, address receiver)
        external
        onlyFacility
        whenNotPaused
        returns (uint256 returned)
    {
        require(assets > 0 && receiver != address(0), "WITHDRAW");
        require(assets <= maxWithdraw(), "LIQUIDITY");
        uint256 shares = IMorphoVaultV2(vault).withdraw(assets, receiver, address(this));
        require(shares > 0, "MORPHO_SHARES");
        returned = assets;
    }

    function totalAssets() public view returns (uint256) {
        return IMorphoVaultV2(vault).convertToAssets(IMorphoVaultV2(vault).balanceOf(address(this)));
    }

    function maxWithdraw() public view returns (uint256) {
        uint256 ownedAssets = totalAssets();
        uint256 venueLimit = IMorphoVaultV2(vault).maxWithdraw(address(this));
        return ownedAssets < venueLimit ? ownedAssets : venueLimit;
    }
}
