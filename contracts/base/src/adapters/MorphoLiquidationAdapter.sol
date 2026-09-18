// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "../IERC20.sol";
import { ILiquidationAdapter } from "../ILiquidationAdapter.sol";
import { IMorphoBlue } from "./MorphoYieldAdapter.sol";

contract MorphoLiquidationAdapter is ILiquidationAdapter {
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public immutable venue;
    address public immutable debtAsset;
    address public immutable collateralAsset;
    bytes32 public immutable marketId;
    IMorphoBlue.MarketParams public marketParams;
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    constructor(address venue_, IMorphoBlue.MarketParams memory marketParams_) {
        require(marketParams_.loanToken != address(0), "INVALID_ASSET");
        require(marketParams_.loanToken != USDBC, "UNSUPPORTED_ASSET");
        require(marketParams_.collateralToken != address(0), "INVALID_COLLATERAL_ASSET");
        venue = venue_;
        debtAsset = marketParams_.loanToken;
        collateralAsset = marketParams_.collateralToken;
        marketId = keccak256(abi.encode(marketParams_));
        marketParams = marketParams_;
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
        // Keep the share conversion in sync with Morpho's accrued totals and
        // virtual-share rounding. The core call is idempotent in this block.
        IMorphoBlue(venue).accrueInterest(marketParams);
        uint256 repaidShares = _toSharesDown(request.maxRepayAssets);
        require(repaidShares != 0, "ZERO_REPAY_SHARES");
        require(IERC20(debtAsset).approve(venue, request.maxRepayAssets), "APPROVAL_FAILED");
        uint256 collateralBefore = IERC20(collateralAsset).balanceOf(address(this));
        (uint256 seizedAssets, uint256 repaid) = IMorphoBlue(venue)
            .liquidate(
                marketParams, request.borrower, 0, repaidShares, bytes("")
            );
        require(IERC20(debtAsset).approve(venue, 0), "APPROVAL_FAILED");
        uint256 debtAfter = IERC20(debtAsset).balanceOf(address(this));
        require(debtAfter >= debtBeforeFunding, "DEBT_BALANCE_INCREASE");
        uint256 unusedFunding = debtAfter - debtBeforeFunding;
        require(unusedFunding <= funded, "DEBT_ACCOUNTING");
        repaidAssets = funded - unusedFunding;
        collateralSeized = IERC20(collateralAsset).balanceOf(address(this)) - collateralBefore;
        require(repaid == repaidAssets, "REPAY_ACCOUNTING");
        require(seizedAssets == collateralSeized, "SEIZE_ACCOUNTING");
        require(repaidAssets != 0 && collateralSeized != 0, "ZERO_EXECUTION");
        require(repaidAssets <= request.maxRepayAssets, "REPAYMENT_EXCEEDS_MAX");
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

    function _toSharesDown(uint256 assets) internal view returns (uint256) {
        IMorphoBlue.Market memory current = IMorphoBlue(venue).market(marketId);
        if (current.totalBorrowAssets == 0 || current.totalBorrowShares == 0) return assets;
        return assets * (uint256(current.totalBorrowShares) + VIRTUAL_SHARES)
            / (uint256(current.totalBorrowAssets) + VIRTUAL_ASSETS);
    }

    function _validate(Request calldata request) internal view {
        require(request.marketId == marketId, "MARKET_MISMATCH");
        require(request.debtAsset == debtAsset, "ASSET_MISMATCH");
        require(request.collateralAsset == collateralAsset, "COLLATERAL_MISMATCH");
    }
}
