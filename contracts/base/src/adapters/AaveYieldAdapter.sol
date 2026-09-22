// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IFacilityAdapter } from "../IFacilityAdapter.sol";
import { IERC20 } from "../IERC20.sol";

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to)
        external
        returns (uint256 withdrawn);

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address borrower,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface IAaveApprovalToken is IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract AaveYieldAdapter is IFacilityAdapter {
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public immutable override asset;
    address public immutable pool;
    address public immutable aToken;

    constructor(address asset_, address pool_, address aToken_) {
        require(asset_ != address(0), "INVALID_ASSET");
        require(asset_ != USDBC, "UNSUPPORTED_ASSET");
        require(aToken_ != address(0), "INVALID_ATOKEN");
        asset = asset_;
        pool = pool_;
        aToken = aToken_;
    }

    function deposit(uint256 assets) external returns (uint256 deployed) {
        require(pool != address(0), "INVALID_VENUE");
        require(
            IAaveApprovalToken(asset).transferFrom(msg.sender, address(this), assets),
            "ASSET_TRANSFER_FAILED"
        );
        require(IAaveApprovalToken(asset).approve(pool, assets), "APPROVAL_FAILED");
        IAavePool(pool).supply(asset, assets, address(this), 0);
        require(IAaveApprovalToken(asset).approve(pool, 0), "APPROVAL_FAILED");
        return assets;
    }

    function withdraw(uint256 assets, address receiver) external returns (uint256 returned) {
        require(pool != address(0), "INVALID_VENUE");
        return IAavePool(pool).withdraw(asset, assets, receiver);
    }

    function totalAssets() public view returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function maxWithdraw() external view returns (uint256) {
        return totalAssets();
    }
}
