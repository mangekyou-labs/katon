// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface MockTokenApproval {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract MockERC1271 {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;
    bytes4 public response = MAGICVALUE;
    bool public shouldRevert;

    function approveToken(address token, address spender, uint256 amount) external {
        MockTokenApproval(token).approve(spender, amount);
    }

    function setResponse(bytes4 newResponse) external {
        response = newResponse;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        require(!shouldRevert, "VALIDATOR_REVERT");
        return response;
    }
}
