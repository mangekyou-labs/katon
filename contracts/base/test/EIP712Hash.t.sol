// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { TestBase } from "./TestBase.sol";
import { BaseEIP712 } from "../src/BaseEIP712.sol";

contract EIP712HashTest is TestBase {
    function testPinnedLiquidationFundingOrderDigest() public pure {
        BaseEIP712.LiquidationFundingOrder memory order = BaseEIP712.LiquidationFundingOrder({
            maker: address(1),
            signer: address(2),
            debtAsset: address(0x10),
            collateralAsset: address(0x20),
            maxRepayAssets: 1_000_000,
            minCollateralOut: 950_000,
            fillMode: 0,
            expiry: 2_000_000_000,
            salt: 7,
            feeLimitBps: 0,
            rfqId: bytes32(uint256(0x42)),
            venue: address(0xbb),
            marketId: bytes32(uint256(0x43))
        });

        assertEq(
            BaseEIP712.hashLiquidationFundingOrder(order, 84532, address(0xaa)),
            0xfc2e8951a694f4bc700e363bef7d939ecd8fcd7da0e7922d49fb213bdd9df0f8
        );
    }
}
