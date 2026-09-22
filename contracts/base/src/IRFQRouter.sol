// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRFQRouter {
    enum FundingSource {
        LP,
        FACILITY
    }

    struct LiquidationRoutePlan {
        bytes32 rfqId;
        address winner;
        address recipient;
        address borrower;
        uint256 deadline;
        FundingSource source;
        address settlementOrFacility;
        address liquidationAdapter;
        uint256 repayAssets;
        uint256 minCollateralOutRfq;
        uint256 minCollateralOutFunder;
        uint256 decisionBlock;
        bytes32 decisionBlockHash;
        bytes fundingPayload;
    }

    enum SwapLiquiditySource {
        LP,
        FACILITY
    }

    struct SwapRoutePlan {
        bytes32 requestId;
        address taker;
        address recipient;
        address stockToken;
        address usdcToken;
        address settlement;
        uint256 sellAmount;
        uint256 minBuyAmount;
        uint16 feeCapBps;
        uint256 deadline;
        uint256 decisionBlock;
        bytes32 decisionBlockHash;
    }

    struct SwapRouteLeg {
        SwapLiquiditySource source;
        address liquidity;
        uint256 stockAmount;
        uint256 minUsdcOut;
        bytes payload;
    }

    function executeLiquidationRoute(LiquidationRoutePlan calldata plan)
        external
        returns (uint256 repaidAssets, uint256 collateralSeized, uint256 fee);

    function executeSwapRoute(SwapRoutePlan calldata plan, SwapRouteLeg[] calldata legs)
        external
        returns (uint256 boughtUsdc, uint256 fee);

    function setOracleGuard(address guard) external;

    function setB20Guard(address guard) external;
}
