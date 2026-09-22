// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "../src/IERC20.sol";
import { ILiquidationAdapter } from "../src/ILiquidationAdapter.sol";

contract MockLiquidationAdapter is ILiquidationAdapter {
    address public immutable collateral;
    uint256 public collateralOut;
    uint256 public debtConsumed;
    bool public useDebtConsumed;
    uint256 public reportedRepaid;
    uint256 public reportedCollateral;
    bool public useReportedValues;
    bool public healthy;
    Request public lastRequest;

    constructor(address collateral_) {
        collateral = collateral_;
    }

    function setCollateralOut(uint256 amount) external {
        collateralOut = amount;
    }

    function setDebtConsumed(uint256 amount) external {
        debtConsumed = amount;
        useDebtConsumed = true;
    }

    function clearDebtConsumed() external {
        useDebtConsumed = false;
    }

    function setReportedValues(uint256 repaid, uint256 collateralAmount) external {
        reportedRepaid = repaid;
        reportedCollateral = collateralAmount;
        useReportedValues = true;
    }

    function clearReportedValues() external {
        useReportedValues = false;
    }

    function setHealthy(bool value) external {
        healthy = value;
    }

    function lastRecipient() external view returns (address) {
        return lastRequest.recipient;
    }

    function lastBorrower() external view returns (address) {
        return lastRequest.borrower;
    }

    function lastMarketId() external view returns (bytes32) {
        return lastRequest.marketId;
    }

    function liquidate(Request calldata request)
        external
        returns (uint256 repaidAssets, uint256 collateralSeized)
    {
        require(!healthy, "HEALTHY");
        lastRequest = request;
        uint256 consumed = useDebtConsumed ? debtConsumed : request.maxRepayAssets;
        require(
            IERC20(request.debtAsset).transferFrom(msg.sender, address(this), consumed),
            "DEBT_TRANSFER_FAILED"
        );
        require(
            IERC20(collateral).transfer(request.recipient, collateralOut),
            "COLLATERAL_TRANSFER_FAILED"
        );
        return (
            useReportedValues ? reportedRepaid : consumed,
            useReportedValues ? reportedCollateral : collateralOut
        );
    }
}
