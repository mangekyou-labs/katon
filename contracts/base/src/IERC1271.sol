// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC1271 {
    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4);
}
