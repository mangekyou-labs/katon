// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {RFQRouter} from "../src/RFQRouter.sol";

/// Golden vector: off-chain matcher resultHash MUST equal keccak256(abi.encode(SwapRoutePlan)).
contract SwapRouteHashVectorTest is TestBase {
    /// Fixture values shared with packages/flare-core and services/fcc-matcher tests.
    function testHashSwapRouteGoldenVector() public pure {
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg({
            source: address(uint160(0xB1)),
            sellAmount: 100 ether,
            minOutput: 95 ether,
            sourceData: hex"010203"
        });

        RFQRouter.SwapRoutePlan memory route = RFQRouter.SwapRoutePlan({
            chainId: 114,
            router: address(uint160(0xAA)),
            commitment: bytes32(uint256(0x11)),
            fccActionId: bytes32(uint256(0x22)),
            decisionBlock: 1_234_567,
            decisionBlockHash: bytes32(uint256(0x33)),
            deadline: 2_000_000_000,
            seller: address(uint160(0xC1)),
            recipient: address(uint160(0xC2)),
            sellToken: address(uint160(0x10)),
            buyToken: address(uint160(0x20)),
            sellAmount: 100 ether,
            minOutput: 95 ether,
            protocolFeeBps: 50,
            eligibilityPolicyId: bytes32(uint256(0x44)),
            eligibilityRevocationEpoch: 0,
            eligibilityRole: 1,
            eligibilityIssuerReference: bytes32(uint256(0x55)),
            legs: legs
        });

        bytes32 got = keccak256(abi.encode(route));
        // Pinned from TS viem encodeAbiParameters + keccak256 of the same fixture.
        bytes32 want = 0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975;
        assertEq(got, want);
    }

    function testJsonMatcherHashDoesNotEqualRouteHash() public pure {
        // Documents the historical bug: keccak(JSON string) != abi.encode(route).
        bytes memory json =
            bytes('{"auction":"0x11","winner":"0xb1","output":"95000000000000000000","sequence":"1"}');
        bytes32 jsonHash = keccak256(json);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(uint160(0xB1)), 100 ether, 95 ether, hex"010203");
        RFQRouter.SwapRoutePlan memory route = RFQRouter.SwapRoutePlan({
            chainId: 114,
            router: address(uint160(0xAA)),
            commitment: bytes32(uint256(0x11)),
            fccActionId: bytes32(uint256(0x22)),
            decisionBlock: 1_234_567,
            decisionBlockHash: bytes32(uint256(0x33)),
            deadline: 2_000_000_000,
            seller: address(uint160(0xC1)),
            recipient: address(uint160(0xC2)),
            sellToken: address(uint160(0x10)),
            buyToken: address(uint160(0x20)),
            sellAmount: 100 ether,
            minOutput: 95 ether,
            protocolFeeBps: 50,
            eligibilityPolicyId: bytes32(uint256(0x44)),
            eligibilityRevocationEpoch: 0,
            eligibilityRole: 1,
            eligibilityIssuerReference: bytes32(uint256(0x55)),
            legs: legs
        });
        assertTrue(jsonHash != keccak256(abi.encode(route)));
    }
}
