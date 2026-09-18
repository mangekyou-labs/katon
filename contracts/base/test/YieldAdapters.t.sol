// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AaveYieldAdapter } from "../src/adapters/AaveYieldAdapter.sol";
import { EulerYieldAdapter } from "../src/adapters/EulerYieldAdapter.sol";
import { MorphoYieldAdapter } from "../src/adapters/MorphoYieldAdapter.sol";
import { IMorphoBlue } from "../src/adapters/MorphoYieldAdapter.sol";
import { LiquidityFacility } from "../src/LiquidityFacility.sol";
import { MockAavePool } from "./MockAavePool.sol";
import { MockERC20 } from "./MockERC20.sol";
import { MockEulerVault } from "./MockEulerVault.sol";
import { MockMorphoBlue } from "./MockMorphoBlue.sol";
import { TestBase } from "./TestBase.sol";

contract YieldAdaptersTest is TestBase {
    address internal constant CURATOR = address(0xC0A7);
    address internal constant EXECUTOR = address(0xEceC);
    address internal constant GUARDIAN = address(0x6AAD);
    address internal constant DEPOSITOR = address(0xD0);
    address internal constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;

    MockERC20 internal usdc;
    MockERC20 internal aToken;
    MockAavePool internal aavePool;
    MockMorphoBlue internal morpho;
    MockEulerVault internal eulerVault;
    AaveYieldAdapter internal aave;
    MorphoYieldAdapter internal morphoAdapter;
    EulerYieldAdapter internal euler;
    LiquidityFacility internal facility;

    function setUp() public {
        usdc = new MockERC20();
        aToken = new MockERC20();
        aavePool = new MockAavePool(address(usdc), address(aToken));
        morpho = new MockMorphoBlue(address(usdc));
        eulerVault = new MockEulerVault(address(usdc));
        aave = new AaveYieldAdapter(address(usdc), address(aavePool), address(aToken));
        morphoAdapter = new MorphoYieldAdapter(
            address(usdc),
            address(morpho),
            IMorphoBlue.MarketParams({
                loanToken: address(usdc),
                collateralToken: address(0xCA11),
                oracle: address(0x0A11),
                irm: address(0x1A11),
                lltv: 8e17
            })
        );
        euler = new EulerYieldAdapter(address(usdc), address(eulerVault));
        facility = new LiquidityFacility(address(usdc), CURATOR, EXECUTOR, GUARDIAN);
        usdc.mint(DEPOSITOR, 300);
        vm.prank(DEPOSITOR);
        usdc.approve(address(facility), 300);
        vm.prank(DEPOSITOR);
        facility.deposit(300, DEPOSITOR);
    }

    function testFacilityAllocatesAndDeallocatesAcrossNamedAdapters() public {
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(aave), true);
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(morphoAdapter), true);
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(euler), true);

        vm.prank(CURATOR);
        facility.allocate(address(aave), 100);
        vm.prank(CURATOR);
        facility.allocate(address(morphoAdapter), 100);
        vm.prank(CURATOR);
        facility.allocate(address(euler), 100);

        assertEq(facility.idleAssets(), 0);
        assertEq(aave.totalAssets(), 100);
        assertEq(morphoAdapter.totalAssets(), 100);
        assertEq(euler.totalAssets(), 100);
        assertEq(facility.totalAssets(), 300);
        assertEq(aave.maxWithdraw(), 100);
        assertEq(morphoAdapter.maxWithdraw(), 100);
        assertEq(euler.maxWithdraw(), 100);

        vm.prank(CURATOR);
        facility.deallocate(address(aave), 40);
        vm.prank(CURATOR);
        facility.deallocate(address(morphoAdapter), 40);
        vm.prank(CURATOR);
        facility.deallocate(address(euler), 40);

        assertEq(facility.idleAssets(), 120);
        assertEq(facility.totalAssets(), 300);
    }

    function testZeroVenueRejectsDepositAndWithdraw() public {
        AaveYieldAdapter badAave = new AaveYieldAdapter(address(usdc), address(0), address(aToken));
        vm.expectRevert(bytes("INVALID_VENUE"));
        badAave.deposit(1);
        vm.expectRevert(bytes("INVALID_VENUE"));
        badAave.withdraw(1, address(this));

        EulerYieldAdapter badEuler = new EulerYieldAdapter(address(usdc), address(0));
        vm.expectRevert(bytes("INVALID_VENUE"));
        badEuler.deposit(1);
        vm.expectRevert(bytes("INVALID_VENUE"));
        badEuler.withdraw(1, address(this));

        MorphoYieldAdapter badMorpho = new MorphoYieldAdapter(
            address(usdc),
            address(0),
            IMorphoBlue.MarketParams({
                loanToken: address(usdc),
                collateralToken: address(0xCA11),
                oracle: address(0x0A11),
                irm: address(0x1A11),
                lltv: 8e17
            })
        );
        vm.expectRevert(bytes("INVALID_VENUE"));
        badMorpho.deposit(1);
        vm.expectRevert(bytes("INVALID_VENUE"));
        badMorpho.withdraw(1, address(this));
    }

    function testFacilityRejectsMismatchedAndBridgedAdapterAssets() public {
        MockERC20 other = new MockERC20();
        AaveYieldAdapter wrongAsset =
            new AaveYieldAdapter(address(other), address(aavePool), address(aToken));
        vm.expectRevert(bytes("ASSET_MISMATCH"));
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(wrongAsset), true);

        vm.expectRevert(bytes("UNSUPPORTED_ASSET"));
        new EulerYieldAdapter(USDBC, address(eulerVault));
    }

    function testVenueRevertRollsBackAllocationAllowance() public {
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(aave), true);
        aavePool.setReverting(true);

        vm.expectRevert(bytes("VENUE_REVERT"));
        vm.prank(CURATOR);
        facility.allocate(address(aave), 100);

        assertEq(usdc.balanceOf(address(facility)), 300);
        assertEq(usdc.allowance(address(facility), address(aave)), 0);
    }
}
