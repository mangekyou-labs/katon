// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20KineticLiq {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IKineticComptrollerLiq {
    function getAccountLiquidity(address account)
        external
        view
        returns (uint256 errorCode, uint256 liquidity, uint256 shortfall);
    function closeFactorMantissa() external view returns (uint256);
}

interface IKineticCTokenLiq {
    function underlying() external view returns (address);
    function comptroller() external view returns (address);
    function borrowBalanceStored(address account) external view returns (uint256);
    function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral)
        external
        returns (uint256 errorCode);
    function redeem(uint256 redeemTokens) external returns (uint256 errorCode);
}

/// @dev Immutable adapter for Kinetic's Compound-style Unitroller and CToken markets.
/// Seized collateral CTokens are redeemed and the measured underlying is returned to the route.
contract KineticLiquidationAdapter {
    uint256 private constant MANTISSA = 1e18;

    address public immutable venue;
    address public immutable market;
    bytes32 public immutable position;
    address public immutable borrower;
    address public immutable debtToken;
    address public immutable collateralToken;
    address public immutable collateralMarket;
    address public owner;
    bool public paused;

    constructor(
        address venue_,
        address market_,
        bytes32 position_,
        address debtToken_,
        address collateralToken_,
        address collateralMarket_
    ) {
        require(venue_ != address(0) && market_ != address(0) && collateralMarket_ != address(0), "CONFIG");
        require(position_ != bytes32(0) && uint256(position_) >> 160 == 0, "POSITION");
        require(debtToken_ != address(0) && collateralToken_ != address(0) && debtToken_ != collateralToken_, "TOKENS");
        require(collateralMarket_ != market_, "KINETIC_MARKETS");
        require(IKineticCTokenLiq(market_).underlying() == debtToken_, "KINETIC_DEBT_UNDERLYING");
        require(
            IKineticCTokenLiq(collateralMarket_).underlying() == collateralToken_,
            "KINETIC_COLLATERAL_UNDERLYING"
        );
        require(
            IKineticCTokenLiq(market_).comptroller() == venue_
                && IKineticCTokenLiq(collateralMarket_).comptroller() == venue_,
            "KINETIC_COMPTROLLER"
        );

        venue = venue_;
        market = market_;
        position = position_;
        borrower = address(uint160(uint256(position_)));
        debtToken = debtToken_;
        collateralToken = collateralToken_;
        collateralMarket = collateralMarket_;
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
        require(recipient != address(0) && recipient != address(this), "RECIPIENT");
        require(
            venue_ == venue && market_ == market && position_ == position && debtToken_ == debtToken
                && collateralToken_ == collateralToken,
            "LIQUIDATION_BINDING"
        );
        require(maxRepay > 0, "AMOUNT");

        (uint256 liquidityError, uint256 liquidity, uint256 shortfall) =
            IKineticComptrollerLiq(venue).getAccountLiquidity(borrower);
        require(liquidityError == 0, "KINETIC_LIQUIDITY");
        require(liquidity == 0 && shortfall > 0, "LIQUIDATION_HEALTH");

        uint256 debtOutstanding = IKineticCTokenLiq(market).borrowBalanceStored(borrower);
        uint256 closeFactor = IKineticComptrollerLiq(venue).closeFactorMantissa();
        require(debtOutstanding > 0 && closeFactor > 0 && closeFactor <= MANTISSA, "KINETIC_CLOSE_FACTOR");
        uint256 maxClose = (debtOutstanding / MANTISSA) * closeFactor
            + ((debtOutstanding % MANTISSA) * closeFactor) / MANTISSA;
        require(maxRepay <= maxClose, "LIQUIDATION_CLOSE_FACTOR");

        IERC20KineticLiq debt = IERC20KineticLiq(debtToken);
        uint256 debtBefore = debt.balanceOf(address(this));
        require(debt.transferFrom(msg.sender, address(this), maxRepay), "DEBT");
        uint256 debtFunded = debt.balanceOf(address(this));
        require(debtFunded >= debtBefore && debtFunded - debtBefore == maxRepay, "DEBT_AMOUNT");

        require(debt.approve(market, 0), "APPROVE_CLEAR");
        require(debt.approve(market, maxRepay), "APPROVE");
        uint256 receiptBefore = IERC20KineticLiq(collateralMarket).balanceOf(address(this));
        require(
            IKineticCTokenLiq(market).liquidateBorrow(borrower, maxRepay, collateralMarket) == 0,
            "KINETIC_LIQUIDATE"
        );
        uint256 debtAfter = debt.balanceOf(address(this));
        require(debtFunded >= debtAfter && debtFunded - debtAfter == maxRepay, "REPAID");
        uint256 receiptAfter = IERC20KineticLiq(collateralMarket).balanceOf(address(this));
        require(receiptAfter > receiptBefore, "COLLATERAL_RECEIPT");
        require(debt.approve(market, 0), "APPROVE_CLEAR");
        require(debt.allowance(address(this), market) == 0, "APPROVAL_RESIDUE");

        IERC20KineticLiq collateral = IERC20KineticLiq(collateralToken);
        uint256 collateralBefore = collateral.balanceOf(address(this));
        uint256 seized = receiptAfter - receiptBefore;
        require(IKineticCTokenLiq(collateralMarket).redeem(seized) == 0, "KINETIC_REDEEM");
        require(IERC20KineticLiq(collateralMarket).balanceOf(address(this)) == receiptBefore, "RECEIPT_RESIDUE");
        uint256 collateralAfter = collateral.balanceOf(address(this));
        require(collateralAfter > collateralBefore, "COLLATERAL");

        uint256 redeemed = collateralAfter - collateralBefore;
        uint256 recipientBefore = collateral.balanceOf(recipient);
        require(collateral.transfer(recipient, redeemed), "COLLATERAL_TRANSFER");
        uint256 recipientAfter = collateral.balanceOf(recipient);
        require(
            recipientAfter >= recipientBefore && recipientAfter - recipientBefore == redeemed,
            "COLLATERAL_RECIPIENT"
        );
        require(collateral.balanceOf(address(this)) == collateralBefore, "COLLATERAL_RESIDUE");
        return maxRepay;
    }
}
