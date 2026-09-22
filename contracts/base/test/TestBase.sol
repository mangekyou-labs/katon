// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function createSelectFork(string calldata rpcUrl, uint256 blockNumber)
        external
        returns (uint256 forkId);
    function createSelectFork(string calldata rpcUrl) external returns (uint256 forkId);
    function deal(address account, uint256 newBalance) external;
    function envOr(string calldata name, string calldata defaultValue)
        external
        returns (string memory value);
    function envString(string calldata name) external returns (string memory value);
    function expectRevert(bytes calldata revertData) external;
    function prank(address account) external;
    function roll(uint256 blockNumber) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function skip(bool skipTest) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function startPrank(address account) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool condition) internal pure {
        require(condition, "assertion failed");
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "bytes32 assertion failed");
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        require(left == right, "uint256 assertion failed");
    }

    function assertEq(address left, address right) internal pure {
        require(left == right, "address assertion failed");
    }
}
