// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IMorphoBlue } from "../src/adapters/MorphoYieldAdapter.sol";
import { IERC20 } from "../src/IERC20.sol";

contract MockMorphoBlue is IMorphoBlue {
    address public immutable asset;
    bool public reverting;
    uint256 public liquidationRepayLimit;
    mapping(bytes32 => Market) internal markets;
    mapping(bytes32 => mapping(address => Position)) internal positions;

    constructor(address asset_) {
        asset = asset_;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function setLiquidationRepayLimit(uint256 value) external {
        liquidationRepayLimit = value;
    }

    function accrueInterest(MarketParams calldata) external view {
        require(!reverting, "VENUE_REVERT");
    }

    function supply(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        bytes calldata data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied) {
        require(!reverting, "VENUE_REVERT");
        require(data.length == 0, "DATA_NOT_EMPTY");
        require(params.loanToken == asset, "WRONG_ASSET");
        bytes32 id = keccak256(abi.encode(params));
        Market storage current = markets[id];
        sharesSupplied = shares;
        if (sharesSupplied == 0) {
            sharesSupplied = current.totalSupplyShares == 0
                ? assets
                : assets * current.totalSupplyShares / current.totalSupplyAssets;
        }
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), assets), "ASSET_TRANSFER_FAILED"
        );
        current.totalSupplyAssets += uint128(assets);
        current.totalSupplyShares += uint128(sharesSupplied);
        positions[id][onBehalfOf].supplyShares += sharesSupplied;
        return (assets, sharesSupplied);
    }

    function withdraw(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalfOf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn) {
        require(!reverting, "VENUE_REVERT");
        bytes32 id = keccak256(abi.encode(params));
        Market storage current = markets[id];
        Position storage position_ = positions[id][onBehalfOf];
        sharesWithdrawn = shares;
        if (sharesWithdrawn == 0) {
            sharesWithdrawn = assets * current.totalSupplyShares / current.totalSupplyAssets;
        }
        require(position_.supplyShares >= sharesWithdrawn, "INSUFFICIENT_SHARES");
        assetsWithdrawn = assets == 0
            ? sharesWithdrawn * current.totalSupplyAssets / current.totalSupplyShares
            : assets;
        position_.supplyShares -= sharesWithdrawn;
        current.totalSupplyShares -= uint128(sharesWithdrawn);
        current.totalSupplyAssets -= uint128(assetsWithdrawn);
        require(IERC20(asset).transfer(receiver, assetsWithdrawn), "ASSET_TRANSFER_FAILED");
        return (assetsWithdrawn, sharesWithdrawn);
    }

    function liquidate(
        MarketParams calldata params,
        address,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 seizedAssetsOut, uint256 repaidAssets) {
        require(!reverting, "VENUE_REVERT");
        require(params.loanToken == asset, "WRONG_ASSET");
        require(seizedAssets == 0, "SEIZED_ASSETS_UNSUPPORTED");
        require(data.length == 0, "DATA_NOT_EMPTY");
        bytes32 id = keccak256(abi.encode(params));
        Market memory current = markets[id];
        repaidAssets = current.totalBorrowAssets == 0 || current.totalBorrowShares == 0
            ? repaidShares
            : repaidShares * current.totalBorrowAssets / current.totalBorrowShares;
        if (liquidationRepayLimit != 0 && liquidationRepayLimit < repaidAssets) {
            repaidAssets = liquidationRepayLimit;
        }
        seizedAssetsOut = repaidAssets * 110 / 100;
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), repaidAssets),
            "ASSET_TRANSFER_FAILED"
        );
        require(
            IERC20(params.collateralToken).transfer(msg.sender, seizedAssetsOut),
            "COLLATERAL_TRANSFER_FAILED"
        );
    }

    function position(bytes32 id, address user) external view returns (Position memory) {
        return positions[id][user];
    }

    function market(bytes32 id) external view returns (Market memory) {
        return markets[id];
    }
}
