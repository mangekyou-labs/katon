// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal two-day operation timelock for proxy administration/configuration.
contract GovernanceTimelock {
    uint64 public immutable minDelay;
    address public immutable proposer;
    address public immutable executor;
    mapping(bytes32 operationId => uint64 eta) public scheduled;
    mapping(bytes32 operationId => bool completed) public completed;

    event OperationScheduled(bytes32 indexed operationId, address indexed target, uint256 value, uint64 eta);
    event OperationExecuted(bytes32 indexed operationId, address indexed target, uint256 value);
    event OperationCancelled(bytes32 indexed operationId);

    constructor(uint64 minDelay_, address proposer_, address executor_) {
        require(minDelay_ >= 2 days, "TIMELOCK_DELAY");
        require(proposer_ != address(0), "PROPOSER_REQUIRED");
        minDelay = minDelay_;
        proposer = proposer_;
        executor = executor_;
    }

    function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, predecessor, salt));
    }

    function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) external returns (bytes32 operationId) {
        require(msg.sender == proposer, "TIMELOCK_PROPOSER");
        require(target != address(0), "TIMELOCK_TARGET");
        operationId = hashOperation(target, value, data, predecessor, salt);
        require(scheduled[operationId] == 0 && !completed[operationId], "TIMELOCK_DUPLICATE");
        uint64 eta = uint64(block.timestamp) + minDelay;
        scheduled[operationId] = eta;
        emit OperationScheduled(operationId, target, value, eta);
    }

    function cancel(bytes32 operationId) external {
        require(msg.sender == proposer, "TIMELOCK_PROPOSER");
        require(scheduled[operationId] != 0, "TIMELOCK_UNKNOWN");
        delete scheduled[operationId];
        emit OperationCancelled(operationId);
    }

    function execute(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) external payable returns (bytes memory result) {
        require(executor == address(0) || msg.sender == executor, "TIMELOCK_EXECUTOR");
        require(msg.value == value, "TIMELOCK_VALUE");
        bytes32 operationId = hashOperation(target, value, data, predecessor, salt);
        uint64 eta = scheduled[operationId];
        require(eta != 0 && block.timestamp >= eta, "TIMELOCK_NOT_READY");
        if (predecessor != bytes32(0)) require(completed[predecessor], "TIMELOCK_PREDECESSOR");
        delete scheduled[operationId];
        completed[operationId] = true;
        (bool ok, bytes memory data_) = target.call{value: value}(data);
        if (!ok) assembly { revert(add(data_, 32), mload(data_)) }
        emit OperationExecuted(operationId, target, value);
        return data_;
    }
}
