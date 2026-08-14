// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20KineticLiquidationMock {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IKineticCollateralMock {
    function comptroller() external view returns (address);
    function seize(address liquidator, address borrower, uint256 seizeTokens) external returns (uint256);
}

/// @dev Interface-faithful mock of the Kinetic Unitroller/Comptroller liquidation reads.
contract MockKineticComptroller {
    struct Liquidity {
        uint256 errorCode;
        uint256 liquidity;
        uint256 shortfall;
    }

    mapping(address => Liquidity) private accountLiquidity;
    uint256 public closeFactorMantissa = 0.5e18;

    function setAccountLiquidity(address borrower, uint256 errorCode, uint256 liquidity, uint256 shortfall)
        external
    {
        accountLiquidity[borrower] = Liquidity(errorCode, liquidity, shortfall);
    }

    function setCloseFactorMantissa(uint256 value) external {
        closeFactorMantissa = value;
    }

    function getAccountLiquidity(address borrower)
        external
        view
        returns (uint256 errorCode, uint256 liquidity, uint256 shortfall)
    {
        Liquidity memory value = accountLiquidity[borrower];
        return (value.errorCode, value.liquidity, value.shortfall);
    }
}

/// @dev Compound-style CToken mock exposing Kinetic's deployed liquidation selectors.
contract MockKineticLiquidationMarket {
    address public immutable underlying;
    address public immutable comptroller;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public borrowBalanceStored;

    uint256 public seizeTokens;
    uint256 public liquidationError;
    uint256 public redeemError;
    uint256 public exchangeRateMantissa = 1e18;

    constructor(address underlying_, address comptroller_) {
        require(underlying_ != address(0) && comptroller_ != address(0), "CONFIG");
        underlying = underlying_;
        comptroller = comptroller_;
    }

    function setBorrowBalance(address borrower, uint256 amount) external {
        borrowBalanceStored[borrower] = amount;
    }

    function mintCollateral(address borrower, uint256 amount) external {
        balanceOf[borrower] += amount;
    }

    function setSeizeTokens(uint256 amount) external {
        seizeTokens = amount;
    }

    function setLiquidationError(uint256 errorCode) external {
        liquidationError = errorCode;
    }

    function setRedeemError(uint256 errorCode) external {
        redeemError = errorCode;
    }

    function setExchangeRateMantissa(uint256 value) external {
        require(value > 0, "RATE");
        exchangeRateMantissa = value;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        if (redeemError != 0) return redeemError;
        if (balanceOf[msg.sender] < redeemTokens) return 2;
        uint256 underlyingAmount = (redeemTokens * exchangeRateMantissa) / 1e18;
        balanceOf[msg.sender] -= redeemTokens;
        require(
            IERC20KineticLiquidationMock(underlying).transfer(msg.sender, underlyingAmount),
            "UNDERLYING_TRANSFER"
        );
        return 0;
    }

    function seize(address liquidator, address borrower, uint256 amount) external returns (uint256) {
        require(IKineticCollateralMock(msg.sender).comptroller() == comptroller, "COMPTROLLER");
        if (balanceOf[borrower] < amount) return 1;
        balanceOf[borrower] -= amount;
        balanceOf[liquidator] += amount;
        return 0;
    }

    function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral)
        external
        returns (uint256)
    {
        if (liquidationError != 0) return liquidationError;
        if (borrowBalanceStored[borrower] < repayAmount) return 2;
        if (IKineticCollateralMock(cTokenCollateral).comptroller() != comptroller) return 3;
        require(
            IERC20KineticLiquidationMock(underlying).transferFrom(msg.sender, address(this), repayAmount),
            "DEBT_TRANSFER"
        );
        borrowBalanceStored[borrower] -= repayAmount;
        if (IKineticCollateralMock(cTokenCollateral).seize(msg.sender, borrower, seizeTokens) != 0) return 4;
        return 0;
    }
}
