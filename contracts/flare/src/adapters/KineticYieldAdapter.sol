// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseYieldAdapter, IERC20YieldAdapter} from "./BaseYieldAdapter.sol";

interface IKineticMarket {
    function underlying() external view returns (address);
    function mint(uint256 mintAmount) external returns (uint256 errorCode);
    function redeemUnderlying(uint256 redeemAmount) external returns (uint256 errorCode);
    function balanceOf(address owner) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
    function getCash() external view returns (uint256);
}

/// @dev Kinetic-style yield adapter: exchange-rate valuation and cash-aware withdrawals.
contract KineticYieldAdapter is BaseYieldAdapter {
    address public immutable market;

    constructor(address facility_, address asset_, address market_, bytes32 marketId_)
        BaseYieldAdapter(facility_, asset_, marketId_)
    {
        require(market_ != address(0), "MARKET");
        require(IKineticMarket(market_).underlying() == asset_, "KINETIC_ASSET");
        market = market_;
    }

    function deposit(uint256 assets) external onlyFacility whenNotPaused returns (uint256 deployed) {
        require(assets > 0, "AMOUNT");
        require(IERC20YieldAdapter(asset).balanceOf(address(this)) >= assets, "BALANCE");
        _approve(market, assets);
        require(IKineticMarket(market).mint(assets) == 0, "KINETIC_MINT");
        _approve(market, 0);
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
        require(IKineticMarket(market).redeemUnderlying(assets) == 0, "KINETIC_REDEEM");
        require(IERC20YieldAdapter(asset).transfer(receiver, assets), "TRANSFER");
        returned = assets;
    }

    function totalAssets() public view returns (uint256) {
        uint256 shares = IKineticMarket(market).balanceOf(address(this));
        return (shares * IKineticMarket(market).exchangeRateStored()) / 1e18;
    }

    function maxWithdraw() public view returns (uint256) {
        uint256 balance = totalAssets();
        uint256 cash = IKineticMarket(market).getCash();
        return balance < cash ? balance : cash;
    }
}
