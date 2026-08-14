// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20MockClearpool {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Interface-faithful Clearpool T-Pool mock (USDX <-> cUSDX style shares).
/// The deployed pool is itself the cUSDX ERC-20 and deposits/withdrawals are
/// always for msg.sender, matching the audited TreasuryYieldPool interface.
contract MockClearpoolTPool {
    IERC20MockClearpool public immutable asset;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address usdx_) {
        require(usdx_ != address(0), "USDX");
        asset = IERC20MockClearpool(usdx_);
    }

    function deposit(uint256 assets) external {
        require(assets > 0, "DEPOSIT");
        require(asset.transferFrom(msg.sender, address(this), assets), "TRANSFER");
        balanceOf[msg.sender] += assets;
        totalSupply += assets;
    }

    function withdraw(uint256 assets) external {
        require(assets > 0, "WITHDRAW");
        require(balanceOf[msg.sender] >= assets, "SHARES");
        require(assets <= cash(), "CASH");
        balanceOf[msg.sender] -= assets;
        totalSupply -= assets;
        require(asset.transfer(msg.sender, assets), "TRANSFER");
    }

    function cash() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function drainCash(address receiver, uint256 assets) external {
        require(asset.transfer(receiver, assets), "TRANSFER");
    }
}
