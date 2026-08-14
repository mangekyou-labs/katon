// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20MockMorpho {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Interface-faithful Morpho-style vault mock for local conformance (not a verified deployment).
contract MockMorphoVault {
    IERC20MockMorpho public immutable asset;
    mapping(address => uint256) public balanceOf;
    uint256 public totalShares;
    uint256 public assetsPerShare = 1e18;

    constructor(address asset_) {
        require(asset_ != address(0), "ASSET");
        asset = IERC20MockMorpho(asset_);
    }

    function setAssetsPerShare(uint256 value) external {
        require(value > 0, "RATE");
        assetsPerShare = value;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets > 0 && receiver != address(0), "DEPOSIT");
        require(asset.transferFrom(msg.sender, address(this), assets), "TRANSFER");
        shares = (assets * 1e18) / assetsPerShare;
        require(shares > 0, "SHARES");
        balanceOf[receiver] += shares;
        totalShares += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(assets > 0 && receiver != address(0), "WITHDRAW");
        require(msg.sender == owner || msg.sender == owner, "AUTH");
        shares = (assets * 1e18 + assetsPerShare - 1) / assetsPerShare;
        require(balanceOf[owner] >= shares, "SHARES");
        balanceOf[owner] -= shares;
        totalShares -= shares;
        require(asset.transfer(receiver, assets), "TRANSFER");
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * assetsPerShare) / 1e18;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        uint256 ownedAssets = convertToAssets(balanceOf[owner]);
        uint256 cash = asset.balanceOf(address(this));
        return ownedAssets < cash ? ownedAssets : cash;
    }
}
