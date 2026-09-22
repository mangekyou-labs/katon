// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "../src/IERC20.sol";

contract MockEulerVault {
    address public immutable asset;
    bool public reverting;
    address public collateralVault;
    uint256 public totalSupply;
    uint256 public storedTotalAssets;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public inheritedDebt;
    mapping(address => uint256) public liquidationShares;
    uint256 public liquidationRepayLimit;
    uint256 public liquidationYieldLimit;

    constructor(address asset_) {
        asset = asset_;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function setCollateralVault(address vault) external {
        collateralVault = vault;
    }

    function setLiquidationLimits(uint256 maxRepay, uint256 maxYield) external {
        liquidationRepayLimit = maxRepay;
        liquidationYieldLimit = maxYield;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(!reverting, "VENUE_REVERT");
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED"
        );
        shares = totalSupply == 0 || storedTotalAssets == 0
            ? assets
            : assets * totalSupply / storedTotalAssets;
        totalSupply += shares;
        balanceOf[receiver] += shares;
        storedTotalAssets += assets;
    }

    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares)
    {
        require(!reverting, "VENUE_REVERT");
        shares = (assets * totalSupply + storedTotalAssets - 1) / storedTotalAssets;
        require(balanceOf[owner] >= shares, "INSUFFICIENT_SHARES");
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        storedTotalAssets -= assets;
        require(IERC20(asset).transfer(receiver, assets), "ASSET_TRANSFER_FAILED");
    }

    function previewWithdraw(uint256 assets) external view returns (uint256 shares) {
        if (totalSupply == 0 || storedTotalAssets == 0) return assets;
        return (assets * totalSupply + storedTotalAssets - 1) / storedTotalAssets;
    }

    function checkLiquidation(address, address, address collateral)
        external
        view
        returns (uint256 maxRepay, uint256 maxYield)
    {
        require(collateral == collateralVault, "WRONG_COLLATERAL_VAULT");
        maxRepay = liquidationRepayLimit == 0 ? type(uint256).max : liquidationRepayLimit;
        maxYield = liquidationYieldLimit == 0 ? type(uint256).max : liquidationYieldLimit;
    }

    function liquidate(address, address collateral, uint256 repayAssets, uint256 minYieldBalance)
        external
    {
        require(!reverting, "VENUE_REVERT");
        require(collateral == collateralVault, "WRONG_COLLATERAL_VAULT");
        uint256 seizedShares = repayAssets * 110 / 100;
        require(seizedShares >= minYieldBalance, "HEALTHY");
        inheritedDebt[msg.sender] += repayAssets;
        MockEulerVault(collateralVault).mintLiquidationShares(msg.sender, seizedShares);
    }

    function repay(uint256 assets, address account) external returns (uint256 shares) {
        require(!reverting, "VENUE_REVERT");
        require(inheritedDebt[account] >= assets, "INSUFFICIENT_DEBT");
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED"
        );
        inheritedDebt[account] -= assets;
        return assets;
    }

    function mintLiquidationShares(address account, uint256 shares) external {
        balanceOf[account] += shares;
        liquidationShares[account] += shares;
        totalSupply += shares;
    }

    function seedUnderlying(uint256 assets) external {
        storedTotalAssets += assets;
    }

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        require(!reverting, "VENUE_REVERT");
        require(balanceOf[owner] >= shares, "INSUFFICIENT_SHARES");
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        if (liquidationShares[owner] >= shares) {
            liquidationShares[owner] -= shares;
            assets = shares;
        } else {
            assets = shares * storedTotalAssets / totalSupply;
            storedTotalAssets -= assets;
        }
        require(IERC20(asset).transfer(receiver, assets), "ASSET_TRANSFER_FAILED");
    }

    function totalAssets() external view returns (uint256) {
        return storedTotalAssets;
    }

    function maxWithdraw(address owner) external view returns (uint256 assets) {
        if (totalSupply == 0) return 0;
        return balanceOf[owner] * storedTotalAssets / totalSupply;
    }
}
