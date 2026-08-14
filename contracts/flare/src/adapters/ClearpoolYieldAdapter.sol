// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseYieldAdapter, IERC20YieldAdapter} from "./BaseYieldAdapter.sol";

interface IClearpoolTPool {
    function asset() external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function deposit(uint256 assets) external;
    function withdraw(uint256 assets) external;
    function cash() external view returns (uint256);
}

/// @dev Clearpool T-Pool yield adapter: USDX facilities only.
contract ClearpoolYieldAdapter is BaseYieldAdapter {
    address public immutable pool;

    constructor(address facility_, address asset_, address pool_, bytes32 marketId_)
        BaseYieldAdapter(facility_, asset_, marketId_)
    {
        require(pool_ != address(0), "POOL");
        require(IClearpoolTPool(pool_).asset() == asset_, "CLEARPOOL_USDX_ONLY");
        pool = pool_;
    }

    function deposit(uint256 assets) external onlyFacility whenNotPaused returns (uint256 deployed) {
        require(assets > 0, "AMOUNT");
        require(IERC20YieldAdapter(asset).balanceOf(address(this)) >= assets, "BALANCE");
        uint256 sharesBefore = IClearpoolTPool(pool).balanceOf(address(this));
        _approve(pool, assets);
        IClearpoolTPool(pool).deposit(assets);
        _approve(pool, 0);
        uint256 sharesAfter = IClearpoolTPool(pool).balanceOf(address(this));
        require(sharesAfter >= sharesBefore && sharesAfter - sharesBefore == assets, "DEPLOYED");
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
        uint256 balanceBefore = IERC20YieldAdapter(asset).balanceOf(address(this));
        IClearpoolTPool(pool).withdraw(assets);
        uint256 balanceAfter = IERC20YieldAdapter(asset).balanceOf(address(this));
        require(balanceAfter >= balanceBefore && balanceAfter - balanceBefore == assets, "RETURNED");
        require(IERC20YieldAdapter(asset).transfer(receiver, assets), "TRANSFER");
        returned = assets;
    }

    function totalAssets() public view returns (uint256) {
        return IClearpoolTPool(pool).balanceOf(address(this));
    }

    function maxWithdraw() public view returns (uint256) {
        uint256 shares = totalAssets();
        uint256 availableCash = IClearpoolTPool(pool).cash();
        return shares < availableCash ? shares : availableCash;
    }
}
