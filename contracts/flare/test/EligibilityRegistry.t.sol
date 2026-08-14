// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../src/EligibilityRegistry.sol";
import "./TestBase.sol";

contract EligibilityRegistryTest is TestBase {
    EligibilityRegistry internal registry;
    bytes32 internal constant POLICY = keccak256("policy-1");
    bytes32 internal constant ISSUER = keccak256("issuer-1");
    address internal constant WALLET = address(0xBEEF);
    uint256 internal constant ROLE_SELLER = 1 << 0;
    uint256 internal constant ROLE_LP = 1 << 1;

    function setUp() public {
        registry = new EligibilityRegistry();
    }

    function testRegistersAndAuthorizesMatchingWalletRoleAndIssuer() public {
        registry.setPolicy(POLICY, WALLET, ROLE_SELLER | ROLE_LP, 100, 200, ISSUER);
        vm.warp(150);

        registry.requireEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0);
        registry.requireEligible(POLICY, WALLET, ROLE_LP, ISSUER, 0);
        assertTrue(registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0));
    }

    function testRejectsWrongRoleIssuerAndTimeWindow() public {
        registry.setPolicy(POLICY, WALLET, ROLE_SELLER, 100, 200, ISSUER);

        vm.warp(150);
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_LP, ISSUER, 0));
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, keccak256("other"), 0));

        vm.warp(99);
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0));
        vm.warp(201);
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0));
    }

    function testRevocationEpochInvalidatesPreviouslyCapturedPolicy() public {
        registry.setPolicy(POLICY, WALLET, ROLE_SELLER, 100, 200, ISSUER);
        vm.warp(150);
        registry.requireEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0);

        registry.revoke(POLICY);

        assertEq(registry.revocationEpoch(POLICY), 1);
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0));
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 1));
    }

    function testRejectsStaleRevocationEpochEvenWhenPolicyIsActive() public {
        registry.setPolicy(POLICY, WALLET, ROLE_SELLER, 100, 200, ISSUER);
        vm.warp(150);
        registry.revoke(POLICY);
        registry.schedulePolicy(POLICY, WALLET, ROLE_SELLER, 150, type(uint64).max, ISSUER);
        vm.warp(block.timestamp + registry.POLICY_DELAY());
        registry.activatePolicy(POLICY);

        assertEq(registry.revocationEpoch(POLICY), 2);
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 1));
        registry.requireEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 2);
    }

    function testExistingPolicyUpdatesRequireTimelock() public {
        registry.setPolicy(POLICY, WALLET, ROLE_SELLER, 100, 200, ISSUER);
        registry.schedulePolicy(POLICY, WALLET, ROLE_LP, 0, type(uint64).max, ISSUER);

        vm.expectRevert(bytes("POLICY_UPDATE_TIMELOCK"));
        registry.activatePolicy(POLICY);

        vm.warp(block.timestamp + registry.POLICY_DELAY());
        registry.activatePolicy(POLICY);
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0));
        assertTrue(registry.isEligible(POLICY, WALLET, ROLE_LP, ISSUER, 1));
    }

    function testOnlyOwnerCanChangePolicies() public {
        vm.prank(WALLET);
        vm.expectRevert(bytes("ONLY_OWNER"));
        registry.setPolicy(POLICY, WALLET, ROLE_SELLER, 100, 200, ISSUER);

        vm.prank(WALLET);
        vm.expectRevert(bytes("ONLY_OWNER"));
        registry.revoke(POLICY);
    }

    function testGuardianCanOnlyPauseEligibilityChecks() public {
        registry.setPolicy(POLICY, WALLET, ROLE_SELLER, 100, 200, ISSUER);
        registry.setGuardian(address(0xCAFE));
        vm.prank(address(0xCAFE));
        registry.guardianPause();
        vm.warp(150);
        assertTrue(!registry.isEligible(POLICY, WALLET, ROLE_SELLER, ISSUER, 0));
        vm.expectRevert(bytes("ONLY_OWNER"));
        vm.prank(address(0xCAFE));
        registry.setPaused(false);
    }
}
