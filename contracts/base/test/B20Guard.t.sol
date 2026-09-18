// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { B20Guard } from "../src/B20Guard.sol";
import { TestBase } from "./TestBase.sol";

contract MockPolicyRegistry {
    mapping(uint64 => mapping(address => bool)) public authorized;
    bool public revertOnRead;

    function setAuthorized(uint64 policy, address account, bool value) external {
        authorized[policy][account] = value;
    }

    function setRevertOnRead(bool value) external {
        revertOnRead = value;
    }

    function isAuthorized(uint64 policy, address account) external view returns (bool) {
        if (revertOnRead) revert("POLICY_REVERT");
        return policy == 0 || authorized[policy][account];
    }
}

contract MockB20Token {
    bytes32 public constant SENDER_SCOPE = keccak256("TRANSFER_SENDER");
    bytes32 public constant RECEIVER_SCOPE = keccak256("TRANSFER_RECEIVER");
    bytes32 public constant SEIZE_HOLDER_SCOPE = keccak256("SEIZE_HOLDER");
    bytes32 public constant SEIZE_RECEIVER_SCOPE = keccak256("SEIZE_RECEIVER");

    uint64 public senderPolicy = 1;
    uint64 public receiverPolicy = 2;
    uint64 public seizeHolderPolicy = 0;
    uint64 public seizeReceiverPolicy = 0;
    uint8[] internal _pausedFeatures;
    uint256 public tokenMultiplier = 1e18;
    mapping(address => uint256) public scaledBalances;
    uint256 public wadPrecision = 1e18;
    bool public revertOnPause;
    bool public revertOnPolicy;
    bool public revertOnAsset;

    function setPolicies(
        uint64 sender_,
        uint64 receiver_,
        uint64 seizeHolder_,
        uint64 seizeReceiver_
    ) external {
        senderPolicy = sender_;
        receiverPolicy = receiver_;
        seizeHolderPolicy = seizeHolder_;
        seizeReceiverPolicy = seizeReceiver_;
    }

    function setPausedFeatures(uint8[] calldata features) external {
        delete _pausedFeatures;
        for (uint256 i; i < features.length; ++i) {
            _pausedFeatures.push(features[i]);
        }
    }

    function setAssetValues(
        uint256 multiplier_,
        uint256 wadPrecision_,
        address account,
        uint256 scaledBalance
    ) external {
        tokenMultiplier = multiplier_;
        wadPrecision = wadPrecision_;
        scaledBalances[account] = scaledBalance;
    }

    function setDependencyReverts(bool pause_, bool policy_, bool asset_) external {
        revertOnPause = pause_;
        revertOnPolicy = policy_;
        revertOnAsset = asset_;
    }

    function pausedFeatures() external view returns (uint8[] memory features) {
        if (revertOnPause) revert("PAUSE_REVERT");
        return _pausedFeatures;
    }

    function TRANSFER_SENDER_POLICY() external view returns (bytes32) {
        if (revertOnPolicy) revert("POLICY_SCOPE_REVERT");
        return SENDER_SCOPE;
    }

    function TRANSFER_RECEIVER_POLICY() external view returns (bytes32) {
        if (revertOnPolicy) revert("POLICY_SCOPE_REVERT");
        return RECEIVER_SCOPE;
    }

    function SEIZE_HOLDER_POLICY() external view returns (bytes32) {
        if (revertOnPolicy) revert("POLICY_SCOPE_REVERT");
        return SEIZE_HOLDER_SCOPE;
    }

    function SEIZE_RECEIVER_POLICY() external view returns (bytes32) {
        if (revertOnPolicy) revert("POLICY_SCOPE_REVERT");
        return SEIZE_RECEIVER_SCOPE;
    }

    function policyId(bytes32 scope) external view returns (uint64) {
        if (revertOnPolicy) revert("POLICY_SCOPE_REVERT");
        if (scope == SENDER_SCOPE) return senderPolicy;
        if (scope == RECEIVER_SCOPE) return receiverPolicy;
        if (scope == SEIZE_HOLDER_SCOPE) return seizeHolderPolicy;
        if (scope == SEIZE_RECEIVER_SCOPE) return seizeReceiverPolicy;
        revert("UNKNOWN_SCOPE");
    }

    function WAD_PRECISION() external view returns (uint256) {
        if (revertOnAsset) revert("ASSET_REVERT");
        return wadPrecision;
    }

    function multiplier() external view returns (uint256) {
        if (revertOnAsset) revert("ASSET_REVERT");
        return tokenMultiplier;
    }

    function scaledBalanceOf(address account) external view returns (uint256) {
        if (revertOnAsset) revert("ASSET_REVERT");
        return scaledBalances[account];
    }
}

contract B20GuardTest is TestBase {
    address internal constant SENDER = address(0x1111);
    address internal constant RECIPIENT = address(0x2222);

    MockPolicyRegistry internal registry;
    MockB20Token internal token;
    B20Guard internal guard;

    function setUp() public {
        registry = new MockPolicyRegistry();
        token = new MockB20Token();
        guard = new B20Guard(address(registry));
        registry.setAuthorized(1, SENDER, true);
        registry.setAuthorized(2, RECIPIENT, true);
    }

    function testTransferAndSeizeLiveScansPauseVector() public {
        guard.requireTransferAndSeizeLive(address(token));

        uint8[] memory mintAndBurn = new uint8[](2);
        mintAndBurn[0] = 1;
        mintAndBurn[1] = 2;
        token.setPausedFeatures(mintAndBurn);
        guard.requireTransferAndSeizeLive(address(token));

        uint8[] memory transfer = new uint8[](1);
        transfer[0] = 0;
        token.setPausedFeatures(transfer);
        vm.expectRevert(bytes("TRANSFER_PAUSED"));
        guard.requireTransferAndSeizeLive(address(token));

        uint8[] memory seize = new uint8[](1);
        seize[0] = 3;
        token.setPausedFeatures(seize);
        vm.expectRevert(bytes("SEIZE_PAUSED"));
        guard.requireTransferAndSeizeLive(address(token));
    }

    function testOlderPauseVectorsAndAppendOnlyValuesAreCompatible() public {
        uint8[] memory older = new uint8[](3);
        older[0] = 0;
        older[1] = 1;
        older[2] = 2;
        token.setPausedFeatures(older);
        vm.expectRevert(bytes("TRANSFER_PAUSED"));
        guard.requireTransferAndSeizeLive(address(token));

        uint8[] memory mintBurnOnly = new uint8[](2);
        mintBurnOnly[0] = 1;
        mintBurnOnly[1] = 2;
        token.setPausedFeatures(mintBurnOnly);
        guard.requireTransferAndSeizeLive(address(token));
    }

    function testTransferAuthorizationUsesDistinctSenderAndReceiverScopes() public {
        guard.requireTransferAuthorized(address(token), SENDER, RECIPIENT);

        registry.setAuthorized(2, RECIPIENT, false);
        vm.expectRevert(bytes("TRANSFER_RECEIVER_UNAUTHORIZED"));
        guard.requireTransferAuthorized(address(token), SENDER, RECIPIENT);

        registry.setAuthorized(2, RECIPIENT, true);
        registry.setAuthorized(1, SENDER, false);
        vm.expectRevert(bytes("TRANSFER_SENDER_UNAUTHORIZED"));
        guard.requireTransferAuthorized(address(token), SENDER, RECIPIENT);
    }

    function testApproveCanRemainUsableWhenTransferIsBlocked() public {
        uint8[] memory transfer = new uint8[](1);
        transfer[0] = 0;
        token.setPausedFeatures(transfer);
        guard.requireTransferAuthorized(address(token), SENDER, RECIPIENT);
    }

    function testMultiplierAndScaledBalanceUseOfficialWadAccessors() public {
        token.setAssetValues(1_250_000_000_000_000_000, 1e18, RECIPIENT, 987_654);
        assertEq(guard.multiplierWad(address(token)), 1_250_000_000_000_000_000);
        assertEq(guard.scaledBalanceOf(address(token), RECIPIENT), 987_654);
    }

    function testRejectsInvalidWadPrecisionAndZeroMultiplier() public {
        token.setAssetValues(1e18, 1e6, RECIPIENT, 1);
        vm.expectRevert(bytes("INVALID_WAD_PRECISION"));
        guard.multiplierWad(address(token));

        token.setAssetValues(0, 1e18, RECIPIENT, 1);
        vm.expectRevert(bytes("INVALID_MULTIPLIER"));
        guard.multiplierWad(address(token));
    }

    function testDependencyFailuresAndZeroAddressesFailClosed() public {
        token.setDependencyReverts(true, false, false);
        vm.expectRevert(bytes("PAUSE_REVERT"));
        guard.requireTransferAndSeizeLive(address(token));

        token.setDependencyReverts(false, true, false);
        vm.expectRevert(bytes("POLICY_SCOPE_REVERT"));
        guard.requireTransferAuthorized(address(token), SENDER, RECIPIENT);

        token.setDependencyReverts(false, false, true);
        vm.expectRevert(bytes("ASSET_REVERT"));
        guard.multiplierWad(address(token));

        vm.expectRevert(bytes("INVALID_TOKEN"));
        guard.requireTransferAndSeizeLive(address(0));

        vm.expectRevert(bytes("INVALID_ACCOUNT"));
        guard.scaledBalanceOf(address(token), address(0));
    }
}
