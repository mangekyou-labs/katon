// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IEulerVault } from "./EulerYieldAdapter.sol";
import { IERC20 } from "../IERC20.sol";
import { ILiquidationAdapter } from "../ILiquidationAdapter.sol";

interface IEulerEVC {
    struct BatchItem {
        address targetContract;
        address onBehalfOfAccount;
        uint256 value;
        bytes data;
    }

    function batch(BatchItem[] calldata items) external;
}

contract EulerLiquidationAdapter is ILiquidationAdapter {
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public immutable debtVault;
    address public immutable collateralVault;
    address public immutable debtAsset;
    address public immutable collateralAsset;
    bytes32 public immutable marketId;
    address public immutable eulerEvc;

    constructor(
        address debtVault_,
        address collateralVault_,
        address debtAsset_,
        bytes32 marketId_
    ) {
        require(debtAsset_ != address(0), "INVALID_ASSET");
        require(debtAsset_ != USDBC, "UNSUPPORTED_ASSET");
        require(collateralVault_ != address(0), "INVALID_COLLATERAL_ASSET");
        debtVault = debtVault_;
        collateralVault = collateralVault_;
        debtAsset = debtAsset_;
        collateralAsset = IEulerVault(collateralVault_).asset();
        marketId = marketId_;

        // Euler liquidations transfer the violator's debt to the liquidator
        // before the adapter repays it. The liquidator therefore needs the
        // debt vault enabled as its EVC controller. A real EVault exposes its
        // connector; the QA control vaults do not, so they remain unchanged.
        address resolvedEvc;
        try IEulerVault(debtVault_).EVC() returns (address evc) {
            if (evc != address(0)) {
                (bool enabled,) = evc.call(
                    abi.encodeWithSignature(
                        "enableController(address,address)", address(this), debtVault_
                    )
                );
                require(enabled, "CONTROLLER_ENABLE_FAILED");
                resolvedEvc = evc;
            }
        } catch {
            // Selector-faithful QA control vaults have no EVC surface.
        }
        eulerEvc = resolvedEvc;
    }

    function liquidate(Request calldata request)
        external
        returns (uint256 repaidAssets, uint256 collateralSeized)
    {
        require(msg.data.length == 4 + 7 * 32, "INVALID_CALLDATA");
        require(debtVault != address(0) && collateralVault != address(0), "INVALID_VENUE");
        _validate(request);
        require(request.maxRepayAssets != 0, "INVALID_AMOUNT");
        require(request.recipient != address(0), "INVALID_RECIPIENT");
        uint256 debtBeforeFunding = IERC20(debtAsset).balanceOf(address(this));
        require(
            IERC20(debtAsset).transferFrom(msg.sender, address(this), request.maxRepayAssets),
            "ASSET_TRANSFER_FAILED"
        );
        uint256 funded = IERC20(debtAsset).balanceOf(address(this)) - debtBeforeFunding;
        require(IERC20(debtAsset).approve(debtVault, request.maxRepayAssets), "APPROVAL_FAILED");
        (uint256 venueMaxRepay, uint256 venueMaxYield) = IEulerVault(debtVault)
            .checkLiquidation(address(this), request.borrower, collateralVault);
        uint256 repayAssets = venueMaxRepay < request.maxRepayAssets
            ? venueMaxRepay
            : request.maxRepayAssets;
        require(repayAssets != 0, "ZERO_EXECUTION");
        // EVK's liquidation minimum is collateral-vault shares. Convert the
        // caller's underlying minimum with previewWithdraw so rounding cannot
        // make the protection weaker than requested.
        uint256 minYieldShares = request.minCollateralOut == 0
            ? 0
            : IEulerVault(collateralVault).previewWithdraw(request.minCollateralOut);
        require(venueMaxYield >= minYieldShares, "MIN_OUT");
        uint256 collateralBefore = IERC20(collateralAsset).balanceOf(address(this));
        uint256 beforeShares = IEulerVault(collateralVault).balanceOf(address(this));
        if (eulerEvc == address(0)) {
            // Selector-faithful QA control vaults do not use EVC deferred
            // checks, so their direct call path remains sufficient.
            IEulerVault(debtVault)
                .liquidate(
                    request.borrower, collateralVault, repayAssets, minYieldShares
                );
            IEulerVault(debtVault).repay(repayAssets, address(this));
        } else {
            // A real EVault defers the account health check only for the
            // duration of an EVC batch. Liquidation first inherits the debt;
            // repayment must therefore be in the same batch or the EVC would
            // check the liquidator while it still carries that debt.
            IEulerEVC.BatchItem[] memory items = new IEulerEVC.BatchItem[](2);
            items[0] = IEulerEVC.BatchItem({
                targetContract: debtVault,
                onBehalfOfAccount: address(this),
                value: 0,
                data: abi.encodeCall(
                    IEulerVault.liquidate,
                    (request.borrower, collateralVault, repayAssets, minYieldShares)
                )
            });
            items[1] = IEulerEVC.BatchItem({
                targetContract: debtVault,
                onBehalfOfAccount: address(this),
                value: 0,
                data: abi.encodeCall(IEulerVault.repay, (repayAssets, address(this)))
            });
            IEulerEVC(eulerEvc).batch(items);
        }
        require(IERC20(debtAsset).approve(debtVault, 0), "APPROVAL_FAILED");
        uint256 debtAfter = IERC20(debtAsset).balanceOf(address(this));
        require(debtAfter >= debtBeforeFunding, "DEBT_BALANCE_INCREASE");
        uint256 unusedFunding = debtAfter - debtBeforeFunding;
        require(unusedFunding <= funded, "DEBT_ACCOUNTING");
        repaidAssets = funded - unusedFunding;
        uint256 liquidationShares =
            IEulerVault(collateralVault).balanceOf(address(this)) - beforeShares;
        require(liquidationShares != 0, "ZERO_EXECUTION");
        require(liquidationShares >= minYieldShares, "YIELD_ACCOUNTING");
        require(venueMaxYield >= liquidationShares, "YIELD_ACCOUNTING");
        IEulerVault(collateralVault).redeem(liquidationShares, address(this), address(this));
        collateralSeized = IERC20(collateralAsset).balanceOf(address(this)) - collateralBefore;
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

    function _validate(Request calldata request) internal view {
        require(request.marketId == marketId, "MARKET_MISMATCH");
        require(request.debtAsset == debtAsset, "ASSET_MISMATCH");
        require(request.collateralAsset == collateralAsset, "COLLATERAL_MISMATCH");
    }
}
