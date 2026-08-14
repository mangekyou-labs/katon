// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20MockKinetic {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Interface-faithful Kinetic-style market mock (exchange-rate valuation + cash cap).
contract MockKineticMarket {
    IERC20MockKinetic public immutable underlying;
    mapping(address => uint256) public balanceOf;
    uint256 public exchangeRateStored = 1e18;
    uint256 public cash;
    uint256 public mintError;
    uint256 public redeemError;

    constructor(address asset_) {
        require(asset_ != address(0), "ASSET");
        underlying = IERC20MockKinetic(asset_);
        cash = 0;
    }

    function setExchangeRate(uint256 rate) external {
        require(rate > 0, "RATE");
        exchangeRateStored = rate;
    }

    function setCash(uint256 amount) external {
        cash = amount;
    }

    function setMintError(uint256 errorCode) external {
        mintError = errorCode;
    }

    function setRedeemError(uint256 errorCode) external {
        redeemError = errorCode;
    }

    function mint(uint256 assets) external returns (uint256 errorCode) {
        if (mintError != 0) return mintError;
        require(assets > 0, "SUPPLY");
        require(underlying.transferFrom(msg.sender, address(this), assets), "TRANSFER");
        uint256 shares = (assets * 1e18) / exchangeRateStored;
        require(shares > 0, "SHARES");
        balanceOf[msg.sender] += shares;
        cash += assets;
        return 0;
    }

    function redeemUnderlying(uint256 assets) external returns (uint256 errorCode) {
        if (redeemError != 0) return redeemError;
        require(assets > 0, "REDEEM");
        require(assets <= cash, "CASH");
        uint256 shares = (assets * 1e18 + exchangeRateStored - 1) / exchangeRateStored;
        require(balanceOf[msg.sender] >= shares, "SHARES");
        balanceOf[msg.sender] -= shares;
        cash -= assets;
        require(underlying.transfer(msg.sender, assets), "TRANSFER");
        return 0;
    }

    function getCash() external view returns (uint256) {
        return cash;
    }
}
