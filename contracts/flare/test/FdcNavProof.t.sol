// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {IWeb2Json, IFdcWeb2JsonVerification, NavProofRegistry} from "../src/ProofGuards.sol";

contract MockFdcWeb2JsonVerification is IFdcWeb2JsonVerification {
    bool public valid;

    function setValid(bool value) external {
        valid = value;
    }

    function verifyWeb2Json(IWeb2Json.Proof calldata) external view returns (bool) {
        return valid;
    }
}

contract FdcNavProofTest is TestBase {
    address private asset = address(0xBEEF);

    function testVerifiedWeb2JsonPayloadUpdatesNavAndBlocksSimulationFallback() public {
        NavProofRegistry registry = new NavProofRegistry();
        MockFdcWeb2JsonVerification verifier = new MockFdcWeb2JsonVerification();
        verifier.setValid(true);
        registry.configureFdcVerification(address(verifier));

        IWeb2Json.Proof memory proof = _proof(100, 200, 123_456);
        registry.configureWeb2JsonPolicy(asset, proof.data.sourceId, keccak256(abi.encode(proof.data.requestBody)));
        registry.submitWeb2JsonNavProof(proof, asset);
        (uint256 value, uint8 decimals, uint64 asOf, uint64 validUntil) = registry.latest(asset);
        assertEq(value, 123_456);
        assertEq(uint256(decimals), 2);
        assertEq(uint256(asOf), 100);
        assertEq(uint256(validUntil), 200);

        vm.expectRevert(bytes("FDC_REAL_MODE"));
        registry.submit(asset, bytes32(uint256(1)), 1, 2, 101, 200, address(this), true);

        vm.expectRevert(bytes("PROOF_REPLAY"));
        registry.submitWeb2JsonNavProof(proof, asset);
    }

    function testInvalidVerifierAndAssetBindingAreRejected() public {
        NavProofRegistry registry = new NavProofRegistry();
        MockFdcWeb2JsonVerification verifier = new MockFdcWeb2JsonVerification();
        registry.configureFdcVerification(address(verifier));
        IWeb2Json.Proof memory proof = _proof(100, 200, 123_456);
        registry.configureWeb2JsonPolicy(asset, proof.data.sourceId, keccak256(abi.encode(proof.data.requestBody)));

        vm.expectRevert(bytes("PROOF_INVALID"));
        registry.submitWeb2JsonNavProof(proof, asset);

        verifier.setValid(true);
        vm.expectRevert(bytes("PROOF_ASSET"));
        registry.submitWeb2JsonNavProof(proof, address(0xCAFE));
    }

    function testWeb2JsonPolicyRejectsWrongSourceAndRequestBody() public {
        NavProofRegistry registry = new NavProofRegistry();
        MockFdcWeb2JsonVerification verifier = new MockFdcWeb2JsonVerification();
        verifier.setValid(true);
        registry.configureFdcVerification(address(verifier));
        IWeb2Json.Proof memory proof = _proof(100, 200, 123_456);
        registry.configureWeb2JsonPolicy(asset, proof.data.sourceId, keccak256(abi.encode(proof.data.requestBody)));

        proof.data.sourceId = bytes32("OtherSource");
        vm.expectRevert(bytes("FDC_SOURCE_ID"));
        registry.submitWeb2JsonNavProof(proof, asset);

        proof = _proof(100, 200, 123_456);
        proof.data.requestBody.url = "https://attacker.invalid/nav";
        vm.expectRevert(bytes("FDC_REQUEST_BODY"));
        registry.submitWeb2JsonNavProof(proof, asset);
    }

    function testOnlyOwnerCanConfigureWeb2JsonPolicyAndPolicyIsImmutable() public {
        NavProofRegistry registry = new NavProofRegistry();
        vm.prank(address(0xCAFE));
        vm.expectRevert(bytes("ONLY_OWNER"));
        registry.configureWeb2JsonPolicy(asset, bytes32("PublicWeb2"), bytes32(uint256(1)));
        registry.configureWeb2JsonPolicy(asset, bytes32("PublicWeb2"), bytes32(uint256(1)));
        vm.expectRevert(bytes("FDC_POLICY_IMMUTABLE"));
        registry.configureWeb2JsonPolicy(asset, bytes32("PublicWeb2"), bytes32(uint256(2)));
    }

    function _proof(uint64 asOf, uint64 validUntil, uint256 value)
        private
        view
        returns (IWeb2Json.Proof memory proof)
    {
        proof.data.attestationType = bytes32("Web2Json");
        proof.data.sourceId = bytes32("PublicWeb2");
        proof.data.votingRound = 7;
        proof.data.lowestUsedTimestamp = asOf;
        proof.data.responseBody.abiEncodedData = abi.encode(asset, value, uint8(2), asOf, validUntil);
        proof.data.requestBody.url = "https://issuer.example/nav";
        proof.data.requestBody.httpMethod = "GET";
        proof.data.requestBody.headers = "{}";
        proof.data.requestBody.queryParams = "{}";
        proof.data.requestBody.body = "{}";
        proof.data.requestBody.postProcessJq = ".";
        proof.data.requestBody.abiSignature = "tuple(address asset,uint256 value,uint8 decimals,uint64 asOf,uint64 validUntil)";
    }
}
