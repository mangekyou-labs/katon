// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20YieldAdapter {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev Immutable facility-scoped yield adapter base. Facility transfers assets before deposit().
abstract contract BaseYieldAdapter {
    address public immutable facility;
    address public immutable asset;
    bytes32 public immutable marketId;
    address public owner;
    bool public paused;

    event Paused(address indexed account);
    event Unpaused(address indexed account);

    modifier onlyFacility() {
        require(msg.sender == facility, "ADAPTER_CALLER");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "ADAPTER_OWNER");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "ADAPTER_PAUSED");
        _;
    }

    constructor(address facility_, address asset_, bytes32 marketId_) {
        require(facility_ != address(0) && asset_ != address(0), "ADAPTER_CONFIG");
        require(marketId_ != bytes32(0), "MARKET_ID");
        facility = facility_;
        asset = asset_;
        marketId = marketId_;
        owner = msg.sender;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function _approve(address spender, uint256 amount) internal {
        require(IERC20YieldAdapter(asset).approve(spender, amount), "APPROVE");
    }
}
