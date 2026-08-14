// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IWeb2Json {
    struct RequestBody {
        string url;
        string httpMethod;
        string headers;
        string queryParams;
        string body;
        string postProcessJq;
        string abiSignature;
    }

    struct ResponseBody {
        bytes abiEncodedData;
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}

interface IFdcWeb2JsonVerification {
    function verifyWeb2Json(IWeb2Json.Proof calldata proof) external view returns (bool);
}

contract NavProofRegistry {
    struct NavRecord {
        uint256 value;
        uint8 decimals;
        uint64 asOf;
        uint64 validUntil;
        bytes32 requestDigest;
    }

    struct Web2JsonPolicy {
        bytes32 sourceId;
        bytes32 requestBodyHash;
        bool configured;
    }

    mapping(address asset => NavRecord) private records;
    mapping(bytes32 requestDigest => bool) public usedRequest;
    mapping(address asset => Web2JsonPolicy) public web2JsonPolicies;
    address public owner;
    address public fdcVerification;
    address public guardian;
    bool public paused;

    event FdcVerificationConfigured(address indexed verification);
    event Web2JsonNavAccepted(
        address indexed asset,
        bytes32 indexed requestDigest,
        uint64 votingRound,
        uint64 asOf,
        uint64 validUntil,
        uint256 value,
        uint8 decimals
    );
    event Web2JsonPolicyConfigured(address indexed asset, bytes32 indexed sourceId, bytes32 requestBodyHash);

    constructor() {
        owner = msg.sender;
    }

    function initialize(address owner_) external {
        require(owner == address(0), "ALREADY_INITIALIZED");
        require(owner_ != address(0), "OWNER_REQUIRED");
        owner = owner_;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_REQUIRED");
        owner = newOwner;
    }

    function setGuardian(address guardian_) external {
        require(msg.sender == owner, "ONLY_OWNER");
        guardian = guardian_;
    }

    function setPaused(bool value) external {
        require(msg.sender == owner, "ONLY_OWNER");
        paused = value;
    }

    function guardianPause() external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        paused = true;
    }

    function configureFdcVerification(address verification) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(verification != address(0), "FDC_VERIFIER_REQUIRED");
        require(fdcVerification == address(0), "FDC_VERIFIER_IMMUTABLE");
        fdcVerification = verification;
        emit FdcVerificationConfigured(verification);
    }

    function configureWeb2JsonPolicy(address asset, bytes32 sourceId, bytes32 requestBodyHash) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(asset != address(0) && sourceId != bytes32(0) && requestBodyHash != bytes32(0), "FDC_POLICY_SCHEMA");
        require(!web2JsonPolicies[asset].configured, "FDC_POLICY_IMMUTABLE");
        web2JsonPolicies[asset] = Web2JsonPolicy(sourceId, requestBodyHash, true);
        emit Web2JsonPolicyConfigured(asset, sourceId, requestBodyHash);
    }

    function submit(
        address asset,
        bytes32 requestDigest,
        uint256 value,
        uint8 decimals,
        uint64 asOf,
        uint64 validUntil,
        address proofOwner,
        bool proofValid
    ) external {
        require(!paused, "NAV_PAUSED");
        require(fdcVerification == address(0), "FDC_REAL_MODE");
        require(asset != address(0) && requestDigest != bytes32(0) && proofOwner != address(0), "PROOF_SCHEMA");
        require(msg.sender == proofOwner, "PROOF_OWNER");
        require(!usedRequest[requestDigest], "PROOF_REPLAY");
        require(proofValid, "PROOF_INVALID");
        require(value > 0 && decimals <= 36 && validUntil >= asOf, "PROOF_SCHEMA");
        require(asOf > records[asset].asOf, "NAV_NOT_MONOTONIC");
        usedRequest[requestDigest] = true;
        records[asset] = NavRecord(value, decimals, asOf, validUntil, requestDigest);
    }

    /// @notice Accepts a NAV payload only after the live FDC verifier validates
    /// its Merkle proof and message-integrity code.
    /// @dev The Web2Json ABI signature must encode
    ///      (address asset, uint256 value, uint8 decimals, uint64 asOf,
    ///      uint64 validUntil). The caller is the proof owner by design.
    function submitWeb2JsonNavProof(
        IWeb2Json.Proof calldata proof,
        address expectedAsset
    ) external {
        require(!paused, "NAV_PAUSED");
        require(fdcVerification != address(0), "FDC_NOT_CONFIGURED");
        require(expectedAsset != address(0), "PROOF_SCHEMA");
        require(proof.data.attestationType == bytes32("Web2Json"), "FDC_ATTESTATION_TYPE");
        require(IFdcWeb2JsonVerification(fdcVerification).verifyWeb2Json(proof), "PROOF_INVALID");

        (address asset, uint256 value, uint8 decimals, uint64 asOf, uint64 validUntil) = abi.decode(
            proof.data.responseBody.abiEncodedData,
            (address, uint256, uint8, uint64, uint64)
        );
        require(asset == expectedAsset, "PROOF_ASSET");
        Web2JsonPolicy memory policy = web2JsonPolicies[asset];
        require(policy.configured, "FDC_POLICY_MISSING");
        require(proof.data.sourceId == policy.sourceId, "FDC_SOURCE_ID");
        require(keccak256(abi.encode(proof.data.requestBody)) == policy.requestBodyHash, "FDC_REQUEST_BODY");
        require(value > 0 && decimals <= 36 && validUntil >= asOf, "PROOF_SCHEMA");

        bytes32 requestDigest = keccak256(abi.encode(proof.data));
        require(!usedRequest[requestDigest], "PROOF_REPLAY");
        require(asOf > records[asset].asOf, "NAV_NOT_MONOTONIC");
        usedRequest[requestDigest] = true;
        records[asset] = NavRecord(value, decimals, asOf, validUntil, requestDigest);
        emit Web2JsonNavAccepted(asset, requestDigest, proof.data.votingRound, asOf, validUntil, value, decimals);
    }

    function latest(address asset)
        external
        view
        returns (uint256 value, uint8 decimals, uint64 asOf, uint64 validUntil)
    {
        NavRecord memory record = records[asset];
        return (record.value, record.decimals, record.asOf, record.validUntil);
    }
}

contract FtsoRiskGuard {
    struct FeedPolicy {
        uint64 maxAge;
        uint16 maxDeviationBps;
        bool configured;
    }

    address public owner;
    address public guardian;
    bool public paused;
    mapping(bytes32 feedId => FeedPolicy) public policies;

    constructor() {
        owner = msg.sender;
    }

    function initialize(address owner_) external {
        require(owner == address(0), "ALREADY_INITIALIZED");
        require(owner_ != address(0), "OWNER_REQUIRED");
        owner = owner_;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_REQUIRED");
        owner = newOwner;
    }

    function setGuardian(address guardian_) external {
        require(msg.sender == owner, "ONLY_OWNER");
        guardian = guardian_;
    }

    function setPaused(bool value) external {
        require(msg.sender == owner, "ONLY_OWNER");
        paused = value;
    }

    function guardianPause() external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        paused = true;
    }

    function configure(bytes32 feedId, uint64 maxAge, uint16 maxDeviationBps) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(feedId != bytes32(0), "FTSO_FEED_REQUIRED");
        require(maxDeviationBps <= 10_000, "FTSO_POLICY");
        policies[feedId] = FeedPolicy(maxAge, maxDeviationBps, true);
    }

    function assertUsable(
        bytes32 feedId,
        int256 value,
        int8 decimals,
        uint64 timestamp,
        int256 referenceValue,
        int8 referenceDecimals
    ) external view returns (uint256 normalized) {
        require(!paused, "FTSO_PAUSED");
        FeedPolicy memory policy = policies[feedId];
        require(policy.configured, "FTSO_FEED_UNSUPPORTED");
        require(decimals >= -36 && decimals <= 36 && referenceDecimals >= -36 && referenceDecimals <= 36, "FTSO_DECIMALS");
        require(timestamp <= block.timestamp && block.timestamp - timestamp <= policy.maxAge, "FTSO_STALE");
        require(value > 0 && referenceValue > 0, "FTSO_VALUE");
        normalized = _normalize(value, decimals);
        uint256 baseline = _normalize(referenceValue, referenceDecimals);
        require(baseline > 0, "FTSO_VALUE");
        uint256 difference = normalized > baseline ? normalized - baseline : baseline - normalized;
        require(difference * 10_000 / baseline <= policy.maxDeviationBps, "FTSO_DEVIATION");
    }

    function _normalize(int256 value, int8 decimals) private pure returns (uint256) {
        int256 exponent = int256(18) + int256(decimals);
        if (exponent >= 0) return uint256(value) * 10 ** uint256(exponent);
        return uint256(value) / 10 ** uint256(-exponent);
    }
}
