// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ILiquidityFacility {
    function asset() external view returns (address);

    function executor() external view returns (address);

    function router() external view returns (address);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares);

    function requestWithdraw(uint256 assets) external returns (uint256 requestId);

    function claimWithdraw(uint256 requestId) external returns (uint256 assets);

    function quoteUsdcCapacity() external view returns (uint256);

    function haircutWad() external view returns (uint256);

    /// @return usdcAmount Current conservative quote for the requested stock.
    /// @return capacity Maximum stock amount currently quoteable.
    /// @return expiry Timestamp through which the quote remains valid.
    function quote(address stockToken, uint256 stockAmount)
        external
        view
        returns (uint256 usdcAmount, uint256 capacity, uint256 expiry);

    function buyStock(address stockToken, uint256 stockAmount, uint256 usdcAmount)
        external
        returns (uint256 paidUsdc);

    function fundLiquidation(uint256 repayAssets, address recipient)
        external
        returns (uint256 fundedUsdc);

    function acquireInventory(address token, uint256 amount, uint256 usdcPaid) external;

    function allocate(address adapter, uint256 assets) external;

    function deallocate(address adapter, uint256 assets) external;
}
