// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library BaseEIP712 {
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

    /// @notice Price-bearing B20 sell order. `stockAmount` is the maximum
    /// stock capacity and `usdcAmount` is the maker's firm total at that
    /// capacity; proportional fills round down in settlement.
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

    bytes32 internal constant LIQUIDATION_FUNDING_ORDER_TYPEHASH = keccak256(
        "LiquidationFundingOrder(address maker,address signer,address debtAsset,address collateralAsset,uint256 maxRepayAssets,uint256 minCollateralOut,uint8 fillMode,uint256 expiry,uint256 salt,uint16 feeLimitBps,bytes32 rfqId,address venue,bytes32 marketId)"
    );
    bytes32 internal constant SWAP_ORDER_TYPEHASH = keccak256(
        "SwapOrder(address maker,address signer,address stockToken,address usdcToken,uint256 stockAmount,uint256 usdcAmount,uint8 fillMode,uint256 expiry,uint256 salt,uint16 feeCapBps,address allowedTaker,bytes32 rfqId)"
    );
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    function hashLiquidationFundingOrder(
        LiquidationFundingOrder memory order,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("KatonRFQSettlement")),
                keccak256(bytes("1")),
                chainId,
                verifyingContract
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                LIQUIDATION_FUNDING_ORDER_TYPEHASH,
                order.maker,
                order.signer,
                order.debtAsset,
                order.collateralAsset,
                order.maxRepayAssets,
                order.minCollateralOut,
                order.fillMode,
                order.expiry,
                order.salt,
                order.feeLimitBps,
                order.rfqId,
                order.venue,
                order.marketId
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function hashSwapOrder(
        SwapOrder memory order,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("KatonRFQSettlement")),
                keccak256(bytes("2")),
                chainId,
                verifyingContract
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                SWAP_ORDER_TYPEHASH,
                order.maker,
                order.signer,
                order.stockToken,
                order.usdcToken,
                order.stockAmount,
                order.usdcAmount,
                order.fillMode,
                order.expiry,
                order.salt,
                order.feeCapBps,
                order.allowedTaker,
                order.rfqId
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
