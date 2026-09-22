// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRFQSettlement {
    struct LiquidationFundingOrder {
        address maker;
        address signer;
        address debtAsset;
        address collateralAsset;
        uint256 maxRepayAssets;
        uint256 minCollateralOut;
        uint8 fillMode;
        uint256 expiry;
        uint256 salt;
        uint16 feeLimitBps;
        bytes32 rfqId;
        address venue;
        bytes32 marketId;
    }

    struct SwapOrder {
        address maker;
        address signer;
        address stockToken;
        address usdcToken;
        uint256 stockAmount;
        uint256 usdcAmount;
        uint8 fillMode;
        uint256 expiry;
        uint256 salt;
        uint16 feeCapBps;
        address allowedTaker;
        bytes32 rfqId;
    }

    event Fill(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed recipient,
        address debtAsset,
        address collateralAsset,
        uint256 repayAssets,
        uint256 collateralOut,
        uint256 fee
    );
    event Cancel(address indexed maker, bytes32 indexed orderHash);
    event SignerUpdated(address indexed maker, address indexed signer, bool authorized);
    event SwapFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        address stockToken,
        address usdcToken,
        uint256 stockAmount,
        uint256 usdcAmount
    );

    function usdc() external view returns (address);

    /// @notice Pull the signed order's maximum funding into the router.
    /// @dev This stage intentionally does not record a fill. The router must
    ///      call finalizeLiquidationOrder after it has measured venue deltas.
    function fundLiquidationOrder(
        LiquidationFundingOrder calldata order,
        bytes calldata signature,
        uint256 maxFunding
    ) external returns (uint256 fundedUsdc);

    /// @notice Record the measured repayment and delivered collateral.
    /// @dev The caller must have a pending funding record created by
    ///      fundLiquidationOrder in the same route transaction.
    function finalizeLiquidationOrder(
        LiquidationFundingOrder calldata order,
        address recipient,
        uint256 actualRepayment,
        uint256 deliveredCollateral,
        uint256 fee
    ) external;

    function registerOrderSigner(address signer) external;
    function revokeOrderSigner(address signer) external;
    function cancelOrder(bytes32 orderHash) external;
    function cancelPairBelowSalt(address debtAsset, address collateralAsset, uint256 minSalt)
        external;

    function fillSwapOrder(
        SwapOrder calldata order,
        bytes calldata signature,
        address taker,
        uint256 stockAmount
    ) external returns (uint256 usdcAmount);

    function swapFilled(bytes32 orderHash) external view returns (uint256);

    function cancelSwapOrder(bytes32 orderHash) external;

    function cancelSwapPairBelowSalt(address stockToken, address usdcToken, uint256 minSalt)
        external;
}
