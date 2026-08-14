// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function expectRevert(bytes calldata message) external;
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function chainId(uint256 newChainId) external;
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber)
        external
        returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue)
        external
        view
        returns (string memory value);
    function envOr(string calldata name, uint256 defaultValue)
        external
        view
        returns (uint256 value);
    function skip(bool skipTest) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 left, uint256 right) internal pure {
        require(left == right, "ASSERT_EQ_UINT");
    }

    function assertEq(address left, address right) internal pure {
        require(left == right, "ASSERT_EQ_ADDRESS");
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "ASSERT_EQ_BYTES32");
    }

    function assertTrue(bool value) internal pure {
        require(value, "ASSERT_TRUE");
    }

    function bound(uint256 value, uint256 min, uint256 max) internal pure returns (uint256) {
        require(min <= max, "BOUND_RANGE");
        return min + (value % (max - min + 1));
    }
}
