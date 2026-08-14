// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20MockLending {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Shared mock position market for Morpho/Kinetic liquidation conformance.
contract MockLendingMarket {
    IERC20MockLending public immutable debtToken;
    IERC20MockLending public immutable collateralToken;

    struct Position {
        uint256 debtOutstanding;
        uint256 collateralAvailable;
        uint256 healthFactorBps;
        uint256 closeFactorBps;
        bool configured;
    }

    mapping(bytes32 => Position) public positions;

    constructor(address debtToken_, address collateralToken_) {
        require(debtToken_ != address(0) && collateralToken_ != address(0), "TOKENS");
        require(debtToken_ != collateralToken_, "PAIR");
        debtToken = IERC20MockLending(debtToken_);
        collateralToken = IERC20MockLending(collateralToken_);
    }

    function configurePosition(
        bytes32 position,
        uint256 debtOutstanding,
        uint256 collateralAvailable,
        uint256 healthFactorBps,
        uint256 closeFactorBps
    ) external {
        require(position != bytes32(0), "POSITION");
        require(debtOutstanding > 0 && collateralAvailable > 0, "BALANCES");
        require(closeFactorBps > 0 && closeFactorBps <= 10_000, "CLOSE_FACTOR");
        positions[position] = Position(debtOutstanding, collateralAvailable, healthFactorBps, closeFactorBps, true);
    }

    function liquidate(bytes32 position, uint256 maxRepay, address recipient)
        external
        returns (uint256 repaid, uint256 collateral)
    {
        Position storage pos = positions[position];
        require(pos.configured, "UNKNOWN_POSITION");
        require(pos.healthFactorBps < 10_000, "HEALTHY");
        require(maxRepay > 0, "REPAY");
        uint256 maxClose = (pos.debtOutstanding * pos.closeFactorBps) / 10_000;
        require(maxRepay <= maxClose, "CLOSE_FACTOR");
        repaid = maxRepay;
        collateral = (pos.collateralAvailable * repaid) / pos.debtOutstanding;
        require(collateral > 0 && collateral <= pos.collateralAvailable, "COLLATERAL");
        require(debtToken.transferFrom(msg.sender, address(this), repaid), "DEBT_TRANSFER");
        require(collateralToken.transfer(recipient, collateral), "COLLATERAL_TRANSFER");
        pos.debtOutstanding -= repaid;
        pos.collateralAvailable -= collateral;
    }
}
