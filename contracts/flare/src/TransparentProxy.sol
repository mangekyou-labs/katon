// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal ERC-1967 transparent proxy used only for coordination-facing modules.
/// @dev The admin can upgrade but cannot invoke implementation functions through the proxy.
contract TransparentUpgradeableProxy {
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    constructor(address implementation_, address admin_, bytes memory data) payable {
        require(implementation_.code.length > 0, "IMPLEMENTATION_CODE");
        require(admin_ != address(0), "ADMIN_REQUIRED");
        _setImplementation(implementation_);
        _setAdmin(admin_);
        if (data.length > 0) {
            (bool ok, bytes memory result) = implementation_.delegatecall(data);
            if (!ok) assembly { revert(add(result, 32), mload(result)) }
        }
    }

    function implementation() external view returns (address value) { value = _implementation(); }
    function admin() external view returns (address value) { value = _admin(); }

    function changeAdmin(address newAdmin) external {
        require(msg.sender == _admin(), "PROXY_ADMIN_ONLY");
        require(newAdmin != address(0), "ADMIN_REQUIRED");
        emit AdminChanged(_admin(), newAdmin);
        _setAdmin(newAdmin);
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable {
        require(msg.sender == _admin(), "PROXY_ADMIN_ONLY");
        require(newImplementation.code.length > 0, "IMPLEMENTATION_CODE");
        _setImplementation(newImplementation);
        emit Upgraded(newImplementation);
        if (data.length > 0) {
            (bool ok, bytes memory result) = newImplementation.delegatecall(data);
            if (!ok) assembly { revert(add(result, 32), mload(result)) }
        }
    }

    fallback() external payable {
        require(msg.sender != _admin(), "PROXY_ADMIN_CANNOT_FALLBACK");
        address target = _implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {
        require(msg.sender != _admin(), "PROXY_ADMIN_CANNOT_FALLBACK");
    }

    function _implementation() private view returns (address value) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly { value := sload(slot) }
    }

    function _admin() private view returns (address value) {
        bytes32 slot = ADMIN_SLOT;
        assembly { value := sload(slot) }
    }

    function _setImplementation(address value) private {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly { sstore(slot, value) }
    }

    function _setAdmin(address value) private {
        bytes32 slot = ADMIN_SLOT;
        assembly { sstore(slot, value) }
    }
}

contract ProxyAdmin {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address owner_) {
        require(owner_ != address(0), "OWNER_REQUIRED");
        owner = owner_;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_REQUIRED");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable {
        require(msg.sender == owner, "ONLY_OWNER");
        TransparentUpgradeableProxy(payable(proxy)).upgradeToAndCall{value: msg.value}(implementation, data);
    }
}
