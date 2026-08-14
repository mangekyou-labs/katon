// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal on-chain eligibility policy boundary shared by fund-moving contracts.
/// @dev Off-chain compliance data stays outside the ledger; only the policy snapshot
///      required at execution time is stored here.
contract EligibilityRegistry {
    uint64 public constant POLICY_DELAY = 2 days;

    struct Policy {
        address wallet;
        uint256 roles;
        uint64 validFrom;
        uint64 expiry;
        bytes32 issuerReference;
        bool active;
    }

    address public owner;
    mapping(bytes32 policyId => Policy policy) public policies;
    mapping(bytes32 policyId => uint256 epoch) public revocationEpoch;
    mapping(bytes32 policyId => bool exists) public policyExists;
    mapping(bytes32 policyId => PendingPolicy pending) public pendingPolicies;
    address public guardian;
    bool public paused;

    struct PendingPolicy {
        address wallet;
        uint256 roles;
        uint64 validFrom;
        uint64 expiry;
        bytes32 issuerReference;
        uint64 eta;
    }

    event PolicyConfigured(
        bytes32 indexed policyId,
        address indexed wallet,
        uint256 roles,
        uint64 validFrom,
        uint64 expiry,
        bytes32 issuerReference,
        uint256 revocationEpoch
    );
    event PolicyRevoked(bytes32 indexed policyId, uint256 revocationEpoch);
    event PolicyUpdateScheduled(bytes32 indexed policyId, uint64 eta);
    event PolicyUpdateCancelled(bytes32 indexed policyId);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function initialize(address owner_) external {
        require(owner == address(0), "ALREADY_INITIALIZED");
        require(owner_ != address(0), "OWNER_REQUIRED");
        owner = owner_;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OWNER_REQUIRED");
        owner = newOwner;
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
    }

    function guardianPause() external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        paused = true;
    }

    function setPolicy(
        bytes32 policyId,
        address wallet,
        uint256 roles,
        uint64 validFrom,
        uint64 expiry,
        bytes32 issuerReference
    ) external onlyOwner {
        require(!policyExists[policyId], "POLICY_EXISTS_USE_TIMELOCK");
        _validatePolicy(policyId, wallet, roles, validFrom, expiry, issuerReference);
        _writePolicy(policyId, wallet, roles, validFrom, expiry, issuerReference);
    }

    function schedulePolicy(
        bytes32 policyId,
        address wallet,
        uint256 roles,
        uint64 validFrom,
        uint64 expiry,
        bytes32 issuerReference
    ) external onlyOwner {
        require(policyExists[policyId], "POLICY_UNKNOWN");
        _validatePolicy(policyId, wallet, roles, validFrom, expiry, issuerReference);
        uint64 eta = uint64(block.timestamp) + POLICY_DELAY;
        pendingPolicies[policyId] = PendingPolicy(wallet, roles, validFrom, expiry, issuerReference, eta);
        emit PolicyUpdateScheduled(policyId, eta);
    }

    function activatePolicy(bytes32 policyId) external onlyOwner {
        PendingPolicy memory pending = pendingPolicies[policyId];
        require(pending.eta != 0, "POLICY_UPDATE_UNKNOWN");
        require(block.timestamp >= pending.eta, "POLICY_UPDATE_TIMELOCK");
        delete pendingPolicies[policyId];
        _writePolicy(policyId, pending.wallet, pending.roles, pending.validFrom, pending.expiry, pending.issuerReference);
    }

    function cancelPolicyUpdate(bytes32 policyId) external onlyOwner {
        require(pendingPolicies[policyId].eta != 0, "POLICY_UPDATE_UNKNOWN");
        delete pendingPolicies[policyId];
        emit PolicyUpdateCancelled(policyId);
    }

    function _validatePolicy(
        bytes32 policyId,
        address wallet,
        uint256 roles,
        uint64 validFrom,
        uint64 expiry,
        bytes32 issuerReference
    ) private pure {
        require(policyId != bytes32(0), "POLICY_REQUIRED");
        require(wallet != address(0), "WALLET_REQUIRED");
        require(roles != 0, "ROLES_REQUIRED");
        require(validFrom <= expiry, "POLICY_WINDOW");
        require(issuerReference != bytes32(0), "ISSUER_REQUIRED");
    }

    function _writePolicy(
        bytes32 policyId,
        address wallet,
        uint256 roles,
        uint64 validFrom,
        uint64 expiry,
        bytes32 issuerReference
    ) private {
        if (policyExists[policyId]) {
            revocationEpoch[policyId] += 1;
        } else {
            policyExists[policyId] = true;
        }
        policies[policyId] = Policy({
            wallet: wallet,
            roles: roles,
            validFrom: validFrom,
            expiry: expiry,
            issuerReference: issuerReference,
            active: true
        });
        emit PolicyConfigured(
            policyId,
            wallet,
            roles,
            validFrom,
            expiry,
            issuerReference,
            revocationEpoch[policyId]
        );
    }

    function revoke(bytes32 policyId) external onlyOwner {
        require(policyExists[policyId], "POLICY_UNKNOWN");
        policies[policyId].active = false;
        revocationEpoch[policyId] += 1;
        emit PolicyRevoked(policyId, revocationEpoch[policyId]);
    }

    function isEligible(
        bytes32 policyId,
        address wallet,
        uint256 role,
        bytes32 issuerReference,
        uint256 expectedRevocationEpoch
    ) public view returns (bool) {
        if (paused) return false;
        Policy memory policy = policies[policyId];
        if (!policyExists[policyId] || !policy.active) return false;
        if (policy.wallet != wallet || role == 0 || policy.roles & role == 0) return false;
        if (block.timestamp < policy.validFrom || block.timestamp > policy.expiry) return false;
        if (policy.issuerReference != issuerReference) return false;
        return revocationEpoch[policyId] == expectedRevocationEpoch;
    }

    function requireEligible(
        bytes32 policyId,
        address wallet,
        uint256 role,
        bytes32 issuerReference,
        uint256 expectedRevocationEpoch
    ) external view {
        require(isEligible(policyId, wallet, role, issuerReference, expectedRevocationEpoch), "NOT_ELIGIBLE");
    }
}
