// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IFacilityAdapter } from "../IFacilityAdapter.sol";
import { IERC20 } from "../IERC20.sol";

interface IMorphoBlue {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }

    function supply(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        bytes calldata data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);

    function withdraw(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 seizedAssetsOut, uint256 repaidAssets);

    function accrueInterest(MarketParams calldata marketParams) external;

    function position(bytes32 id, address user) external view returns (Position memory);

    function market(bytes32 id) external view returns (Market memory);
}

interface IMorphoApprovalToken is IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract MorphoYieldAdapter is IFacilityAdapter {
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public immutable override asset;
    address public immutable venue;
    IMorphoBlue.MarketParams public marketParams;

    constructor(address asset_, address venue_, IMorphoBlue.MarketParams memory marketParams_) {
        require(asset_ != address(0), "INVALID_ASSET");
        require(asset_ != USDBC, "UNSUPPORTED_ASSET");
        asset = asset_;
        venue = venue_;
        marketParams = marketParams_;
    }

    function deposit(uint256 assets) external returns (uint256 deployed) {
        require(venue != address(0), "INVALID_VENUE");
        require(
            IMorphoApprovalToken(asset).transferFrom(msg.sender, address(this), assets),
            "ASSET_TRANSFER_FAILED"
        );
        require(IMorphoApprovalToken(asset).approve(venue, assets), "APPROVAL_FAILED");
        (deployed,) = IMorphoBlue(venue).supply(marketParams, assets, 0, address(this), bytes(""));
        require(IMorphoApprovalToken(asset).approve(venue, 0), "APPROVAL_FAILED");
    }

    function withdraw(uint256 assets, address receiver) external returns (uint256 returned) {
        require(venue != address(0), "INVALID_VENUE");
        (returned,) = IMorphoBlue(venue).withdraw(marketParams, assets, 0, address(this), receiver);
    }

    function totalAssets() public view returns (uint256) {
        if (venue == address(0)) return 0;
        return
            _assetsForShares(IMorphoBlue(venue).position(_marketId(), address(this)).supplyShares);
    }

    function maxWithdraw() external view returns (uint256) {
        return totalAssets();
    }

    function _marketId() internal view returns (bytes32) {
        return keccak256(abi.encode(marketParams));
    }

    function _assetsForShares(uint256 shares) internal view returns (uint256) {
        if (shares == 0 || venue == address(0)) return 0;
        IMorphoBlue.Market memory current = IMorphoBlue(venue).market(_marketId());
        if (current.totalSupplyShares == 0) return 0;
        return shares * current.totalSupplyAssets / current.totalSupplyShares;
    }
}
