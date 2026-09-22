// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ILiquidationAdapter {
    struct Request {
        bytes32 marketId;
        address borrower;
        address debtAsset;
        address collateralAsset;
        uint256 maxRepayAssets;
        uint256 minCollateralOut;
        address recipient;
    }

    /// @notice Liquidate a typed position using at most `maxRepayAssets`.
    /// @dev Both return values are measured execution results. They are never
    ///      the requested maxima unless the venue actually consumed/delivered
    ///      those amounts.
    function liquidate(Request calldata request)
        external
        returns (uint256 repaidAssets, uint256 collateralSeized);
}
