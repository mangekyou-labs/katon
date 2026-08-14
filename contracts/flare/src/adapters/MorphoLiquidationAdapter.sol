// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Liquidation {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IMockLendingMarket {
    function liquidate(bytes32 position, uint256 maxRepay, address recipient)
        external
        returns (uint256 repaid, uint256 collateral);
    function positions(bytes32 position)
        external
        view
        returns (
            uint256 debtOutstanding,
            uint256 collateralAvailable,
            uint256 healthFactorBps,
            uint256 closeFactorBps,
            bool configured
        );
}

/// @dev Immutable Morpho liquidation adapter bound to one venue/market/position/token set.
contract MorphoLiquidationAdapter {
    address public immutable venue;
    address public immutable market;
    bytes32 public immutable position;
    address public immutable debtToken;
    address public immutable collateralToken;
    address public immutable lendingMarket;
    address public owner;
    bool public paused;

    constructor(
        address venue_,
        address market_,
        bytes32 position_,
        address debtToken_,
        address collateralToken_,
        address lendingMarket_
    ) {
        require(venue_ != address(0) && market_ != address(0) && lendingMarket_ != address(0), "CONFIG");
        require(position_ != bytes32(0), "POSITION");
        require(debtToken_ != address(0) && collateralToken_ != address(0) && debtToken_ != collateralToken_, "TOKENS");
        venue = venue_;
        market = market_;
        position = position_;
        debtToken = debtToken_;
        collateralToken = collateralToken_;
        lendingMarket = lendingMarket_;
        owner = msg.sender;
    }

    function pause() external {
        require(msg.sender == owner, "OWNER");
        paused = true;
    }

    function unpause() external {
        require(msg.sender == owner, "OWNER");
        paused = false;
    }

    function liquidate(
        address venue_,
        address market_,
        bytes32 position_,
        address debtToken_,
        address collateralToken_,
        uint256 maxRepay,
        address recipient,
        bytes calldata
    ) external returns (uint256 repaid) {
        require(!paused, "LIQUIDATION_PAUSED");
        require(recipient != address(0), "RECIPIENT");
        require(
            venue_ == venue && market_ == market && position_ == position && debtToken_ == debtToken
                && collateralToken_ == collateralToken,
            "LIQUIDATION_BINDING"
        );
        require(maxRepay > 0, "AMOUNT");

        (
            uint256 debtOutstanding,
            ,
            uint256 healthFactorBps,
            uint256 closeFactorBps,
            bool configured
        ) = IMockLendingMarket(lendingMarket).positions(position);
        require(configured, "POSITION");
        require(healthFactorBps < 10_000, "LIQUIDATION_HEALTH");
        uint256 maxClose = (debtOutstanding * closeFactorBps) / 10_000;
        require(maxRepay <= maxClose, "LIQUIDATION_CLOSE_FACTOR");

        require(IERC20Liquidation(debtToken).transferFrom(msg.sender, address(this), maxRepay), "DEBT");
        require(IERC20Liquidation(debtToken).approve(lendingMarket, maxRepay), "APPROVE");
        (repaid,) = IMockLendingMarket(lendingMarket).liquidate(position, maxRepay, recipient);
        require(repaid == maxRepay, "REPAID");
        require(IERC20Liquidation(debtToken).approve(lendingMarket, 0), "APPROVE_CLEAR");
    }
}
