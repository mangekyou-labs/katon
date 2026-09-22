// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAavePool } from "./AaveYieldAdapter.sol";
import { IERC20 } from "../IERC20.sol";
import { ILiquidationAdapter } from "../ILiquidationAdapter.sol";

contract AaveLiquidationAdapter is ILiquidationAdapter {
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public immutable venue;
    address public immutable debtAsset;
    address public immutable collateralAsset;
    bytes32 public immutable marketId;

    constructor(address venue_, address debtAsset_, address collateralAsset_, bytes32 marketId_) {
        require(debtAsset_ != address(0), "INVALID_ASSET");
        require(debtAsset_ != USDBC, "UNSUPPORTED_ASSET");
        require(collateralAsset_ != address(0), "INVALID_COLLATERAL_ASSET");
        venue = venue_;
        debtAsset = debtAsset_;
        collateralAsset = collateralAsset_;
        marketId = marketId_;
    }

    function liquidate(Request calldata request)
        external
        returns (uint256 repaidAssets, uint256 collateralSeized)
    {
        require(msg.data.length == 4 + 7 * 32, "INVALID_CALLDATA");
        require(venue != address(0), "INVALID_VENUE");
        _validate(request);
        require(request.maxRepayAssets != 0, "INVALID_AMOUNT");
        require(request.recipient != address(0), "INVALID_RECIPIENT");
        uint256 debtBeforeFunding = IERC20(debtAsset).balanceOf(address(this));
        require(
            IERC20(debtAsset).transferFrom(msg.sender, address(this), request.maxRepayAssets),
            "ASSET_TRANSFER_FAILED"
        );
        uint256 funded = IERC20(debtAsset).balanceOf(address(this)) - debtBeforeFunding;
        require(IERC20(debtAsset).approve(venue, request.maxRepayAssets), "APPROVAL_FAILED");
        uint256 collateralBefore = IERC20(collateralAsset).balanceOf(address(this));
        IAavePool(venue)
            .liquidationCall(
                collateralAsset, debtAsset, request.borrower, request.maxRepayAssets, false
            );
        require(IERC20(debtAsset).approve(venue, 0), "APPROVAL_FAILED");
        uint256 debtAfter = IERC20(debtAsset).balanceOf(address(this));
        require(debtAfter >= debtBeforeFunding, "DEBT_BALANCE_INCREASE");
        uint256 unusedFunding = debtAfter - debtBeforeFunding;
        require(unusedFunding <= funded, "DEBT_ACCOUNTING");
        repaidAssets = funded - unusedFunding;
        collateralSeized = IERC20(collateralAsset).balanceOf(address(this)) - collateralBefore;
        require(repaidAssets != 0 && collateralSeized != 0, "ZERO_EXECUTION");
        require(collateralSeized >= request.minCollateralOut, "MIN_OUT");
        if (unusedFunding != 0) {
            require(IERC20(debtAsset).transfer(msg.sender, unusedFunding), "FUNDING_REFUND_FAILED");
        }
        require(IERC20(debtAsset).balanceOf(address(this)) == debtBeforeFunding, "DEBT_DUST");
        require(
            IERC20(collateralAsset).transfer(request.recipient, collateralSeized),
            "COLLATERAL_TRANSFER_FAILED"
        );
        return (repaidAssets, collateralSeized);
    }

    function _validate(Request calldata request) internal view {
        require(request.marketId == marketId, "MARKET_MISMATCH");
        require(request.debtAsset == debtAsset, "ASSET_MISMATCH");
        require(request.collateralAsset == collateralAsset, "COLLATERAL_MISMATCH");
    }
}
