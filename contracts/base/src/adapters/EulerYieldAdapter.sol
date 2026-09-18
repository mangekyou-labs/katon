// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IFacilityAdapter } from "../IFacilityAdapter.sol";
import { IERC20 } from "../IERC20.sol";

interface IEulerVault {
    function asset() external view returns (address);

    function EVC() external view returns (address);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares);

    function previewWithdraw(uint256 assets) external view returns (uint256 shares);

    function liquidate(
        address violator,
        address collateral,
        uint256 repayAssets,
        uint256 minYieldBalance
    ) external;

    function checkLiquidation(address liquidator, address violator, address collateral)
        external
        view
        returns (uint256 maxRepay, uint256 maxYield);

    function repay(uint256 assets, address account) external returns (uint256 shares);

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets);

    function totalAssets() external view returns (uint256 assets);

    function maxWithdraw(address owner) external view returns (uint256 assets);

    function balanceOf(address owner) external view returns (uint256 shares);
}

interface IEulerApprovalToken is IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract EulerYieldAdapter is IFacilityAdapter {
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public immutable override asset;
    address public immutable vault;

    constructor(address asset_, address vault_) {
        require(asset_ != address(0), "INVALID_ASSET");
        require(asset_ != USDBC, "UNSUPPORTED_ASSET");
        asset = asset_;
        vault = vault_;
    }

    function deposit(uint256 assets) external returns (uint256 deployed) {
        require(vault != address(0), "INVALID_VENUE");
        require(
            IEulerApprovalToken(asset).transferFrom(msg.sender, address(this), assets),
            "ASSET_TRANSFER_FAILED"
        );
        require(IEulerApprovalToken(asset).approve(vault, assets), "APPROVAL_FAILED");
        deployed = IEulerVault(vault).deposit(assets, address(this));
        require(IEulerApprovalToken(asset).approve(vault, 0), "APPROVAL_FAILED");
    }

    function withdraw(uint256 assets, address receiver) external returns (uint256 returned) {
        require(vault != address(0), "INVALID_VENUE");
        returned = IEulerVault(vault).withdraw(assets, receiver, address(this));
    }

    function totalAssets() public view returns (uint256) {
        if (vault == address(0)) return 0;
        return IEulerVault(vault).maxWithdraw(address(this));
    }

    function maxWithdraw() external view returns (uint256) {
        return totalAssets();
    }
}
