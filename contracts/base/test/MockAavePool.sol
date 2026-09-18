// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "../src/IERC20.sol";
import { MockERC20 } from "./MockERC20.sol";

contract MockAavePool {
    address public immutable asset;
    address public immutable aToken;
    bool public reverting;
    uint256 public liquidationDebtLimit;

    constructor(address asset_, address aToken_) {
        asset = asset_;
        aToken = aToken_;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function setLiquidationDebtLimit(uint256 value) external {
        liquidationDebtLimit = value;
    }

    function supply(address asset_, uint256 amount, address onBehalfOf, uint16) external {
        require(!reverting, "VENUE_REVERT");
        require(asset_ == asset, "WRONG_ASSET");
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), amount), "ASSET_TRANSFER_FAILED"
        );
        MockERC20(aToken).mint(onBehalfOf, amount);
    }

    function withdraw(address asset_, uint256 amount, address to)
        external
        returns (uint256 withdrawn)
    {
        require(!reverting, "VENUE_REVERT");
        require(asset_ == asset, "WRONG_ASSET");
        MockERC20(aToken).burn(msg.sender, amount);
        require(IERC20(asset).transfer(to, amount), "ASSET_TRANSFER_FAILED");
        return amount;
    }

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address,
        uint256 debtToCover,
        bool receiveAToken
    ) external {
        require(!reverting, "VENUE_REVERT");
        require(!receiveAToken, "ATOKEN_UNSUPPORTED");
        require(debtAsset == asset, "WRONG_ASSET");
        uint256 consumed = liquidationDebtLimit != 0 && liquidationDebtLimit < debtToCover
            ? liquidationDebtLimit
            : debtToCover;
        require(
            IERC20(debtAsset).transferFrom(msg.sender, address(this), consumed),
            "ASSET_TRANSFER_FAILED"
        );
        require(
            IERC20(collateralAsset).transfer(msg.sender, consumed * 110 / 100),
            "COLLATERAL_TRANSFER_FAILED"
        );
    }
}
