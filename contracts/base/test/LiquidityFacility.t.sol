// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { MockERC20 } from "./MockERC20.sol";
import { MockFacilityAdapter } from "./MockFacilityAdapter.sol";
import { TestBase } from "./TestBase.sol";
import { LiquidityFacility } from "../src/LiquidityFacility.sol";

contract LiquidityFacilityTest is TestBase {
    address internal constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address internal constant CURATOR = address(0xC0A7);
    address internal constant EXECUTOR = address(0xEceC);
    address internal constant GUARDIAN = address(0x6AAD);

    MockERC20 internal usdc;
    MockERC20 internal collateral;
    MockFacilityAdapter internal adapter;
    LiquidityFacility internal facility;
    address internal depositor = address(0xD0);
    address internal receiver = address(0xB0B);

    function setUp() public {
        usdc = new MockERC20();
        collateral = new MockERC20();
        adapter = new MockFacilityAdapter(address(usdc));
        facility = new LiquidityFacility(address(usdc), CURATOR, EXECUTOR, GUARDIAN);
        facility.setRouter(address(this));
        usdc.mint(depositor, 1_000);
        vm.prank(depositor);
        usdc.approve(address(facility), 1_000);
    }

    function testConstructorRejectsBridgedUsdcAndZeroAsset() public {
        vm.expectRevert(bytes("UNSUPPORTED_ASSET"));
        new LiquidityFacility(USDBC, CURATOR, EXECUTOR, GUARDIAN);

        vm.expectRevert(bytes("INVALID_ASSET"));
        new LiquidityFacility(address(0), CURATOR, EXECUTOR, GUARDIAN);
    }

    function testDepositUsesCurrentNavWithDownwardRounding() public {
        vm.prank(depositor);
        uint256 firstShares = facility.deposit(100, depositor);
        assertEq(firstShares, 100);

        usdc.mint(address(facility), 100);
        vm.prank(depositor);
        uint256 laterShares = facility.deposit(100, depositor);
        assertEq(laterShares, 50);
        assertEq(facility.totalSupply(), 150);
        assertEq(facility.totalAssets(), 300);
    }

    function testWithdrawPullsAdapterLiquidityWhenAvailable() public {
        vm.prank(depositor);
        facility.deposit(100, depositor);
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(adapter), true);
        vm.prank(CURATOR);
        facility.allocate(address(adapter), 80);

        vm.prank(depositor);
        uint256 shares = facility.withdraw(70, receiver, depositor);

        assertEq(shares, 70);
        assertEq(usdc.balanceOf(receiver), 70);
        assertEq(adapter.totalAssets(), 30);
        assertEq(facility.totalAssets(), 30);
    }

    function testIlliquidRequestLocksSharesAndClaimIsFifoAfterDeallocate() public {
        vm.prank(depositor);
        facility.deposit(200, depositor);
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(adapter), true);
        vm.prank(CURATOR);
        facility.allocate(address(adapter), 200);
        adapter.setWithdrawLimit(0);

        vm.expectRevert(bytes("ILLIQUID"));
        vm.prank(depositor);
        facility.withdraw(1, receiver, depositor);

        vm.prank(depositor);
        uint256 firstId = facility.requestWithdraw(120);
        vm.prank(depositor);
        uint256 secondId = facility.requestWithdraw(80);

        assertEq(facility.balanceOf(depositor), 0);
        assertEq(facility.reservedQueueAssets(), 200);
        assertEq(firstId, 1);
        assertEq(secondId, 2);

        vm.expectRevert(bytes("NOT_QUEUE_HEAD"));
        vm.prank(depositor);
        facility.claimWithdraw(secondId);

        adapter.setWithdrawLimit(200);
        vm.prank(CURATOR);
        facility.deallocate(address(adapter), 200);

        vm.prank(depositor);
        facility.claimWithdraw(firstId);
        assertEq(usdc.balanceOf(depositor), 920);
        assertEq(facility.reservedQueueAssets(), 80);

        vm.prank(depositor);
        facility.claimWithdraw(secondId);
        assertEq(usdc.balanceOf(depositor), 1_000);
        assertEq(facility.reservedQueueAssets(), 0);
    }

    function testAllocateRequiresAllowlistAndDeallocateUsesBalanceDelta() public {
        vm.prank(depositor);
        facility.deposit(100, depositor);

        vm.expectRevert(bytes("ADAPTER_NOT_ALLOWED"));
        vm.prank(CURATOR);
        facility.allocate(address(adapter), 50);

        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(adapter), true);
        vm.prank(CURATOR);
        facility.allocate(address(adapter), 100);
        assertEq(adapter.totalAssets(), 100);

        vm.prank(CURATOR);
        facility.deallocate(address(adapter), 40);
        assertEq(usdc.balanceOf(address(facility)), 40);
        assertEq(adapter.totalAssets(), 60);
    }

    function testQuoteAppliesCapacityHaircutAndNeverExceedsWithdrawable() public {
        vm.prank(depositor);
        facility.deposit(100, depositor);
        vm.prank(CURATOR);
        facility.setHaircutWad(2e17);
        assertEq(facility.quoteUsdcCapacity(), 80);

        vm.prank(CURATOR);
        facility.setHaircutWad(0);
        assertEq(facility.quoteUsdcCapacity(), 100);
    }

    function testStockQuoteRequiresRedemptionPathAndAppliesFreshPriceMultiplierHaircutAndCap()
        public
    {
        vm.prank(depositor);
        facility.deposit(1_000, depositor);

        vm.prank(CURATOR);
        facility.setStockPrice(address(collateral), 2e18);
        vm.prank(CURATOR);
        facility.setStockMultiplier(address(collateral), 15e17);
        vm.prank(CURATOR);
        facility.setHaircutWad(1e17);
        vm.prank(CURATOR);
        facility.setStockExposureCap(address(collateral), 100);

        (uint256 usdcAmount, uint256 capacity, uint256 expiry) =
            facility.quote(address(collateral), 10);
        assertEq(usdcAmount, 0);
        assertEq(capacity, 0);
        assertEq(expiry, 0);

        vm.prank(CURATOR);
        facility.setRedemptionPath(address(collateral), EXECUTOR, true);
        (usdcAmount, capacity, expiry) = facility.quote(address(collateral), 10);
        assertEq(usdcAmount, 27);
        assertEq(capacity, 100);
        assertTrue(expiry > block.timestamp);

        vm.warp(expiry + 1);
        (usdcAmount, capacity, expiry) = facility.quote(address(collateral), 10);
        assertEq(usdcAmount, 0);
        assertEq(capacity, 0);
        assertEq(expiry, 0);
    }

    function testStockQuoteRespectsQueuedWithdrawalReserve() public {
        vm.prank(depositor);
        facility.deposit(1_000, depositor);
        vm.prank(depositor);
        facility.requestWithdraw(900);

        vm.prank(CURATOR);
        facility.setStockPrice(address(collateral), 2e18);
        vm.prank(CURATOR);
        facility.setStockExposureCap(address(collateral), 1_000);
        vm.prank(CURATOR);
        facility.setRedemptionPath(address(collateral), EXECUTOR, true);

        (uint256 usdcAmount, uint256 capacity, uint256 expiry) = facility.quote(address(collateral), 60);
        assertEq(usdcAmount, 0);
        assertEq(capacity, 50);
        assertTrue(expiry > block.timestamp);

        (usdcAmount, capacity, expiry) = facility.quote(address(collateral), 50);
        assertEq(usdcAmount, 100);
        assertEq(capacity, 50);
        assertTrue(expiry > block.timestamp);
    }

    function testBuyStockBooksRedemptionAndRealizesLossFromApSettlement() public {
        vm.prank(depositor);
        facility.deposit(1_000, depositor);
        vm.prank(CURATOR);
        facility.setStockPrice(address(collateral), 2e18);
        vm.prank(CURATOR);
        facility.setStockExposureCap(address(collateral), 100);
        vm.prank(CURATOR);
        facility.setRedemptionPath(address(collateral), EXECUTOR, true);
        collateral.mint(address(facility), 10);

        uint256 paid = facility.buyStock(address(collateral), 10, 20);
        assertEq(paid, 20);
        assertEq(facility.stockExposure(address(collateral)), 10);
        assertEq(facility.inventoryAtAcquisitionCost(), 20);
        (address token, uint256 amount, uint256 acquisitionCost, address operator, bool settled) =
            facility.redemptionLots(0);
        assertEq(token, address(collateral));
        assertEq(amount, 10);
        assertEq(acquisitionCost, 20);
        assertEq(operator, EXECUTOR);
        assertTrue(!settled);

        usdc.mint(EXECUTOR, 15);
        vm.prank(EXECUTOR);
        usdc.approve(address(facility), 15);
        vm.prank(EXECUTOR);
        int256 pnl = facility.settleRedemption(0, 15);

        assertEq(uint256(-pnl), 5);
        assertEq(facility.realizedProfit(), 0);
        assertEq(facility.realizedLoss(), 5);
        assertEq(facility.inventoryAtAcquisitionCost(), 0);
        assertEq(facility.stockExposure(address(collateral)), 0);
        assertEq(collateral.balanceOf(EXECUTOR), 10);
        assertEq(usdc.balanceOf(address(facility)), 995);
    }

    function testFundLiquidationRestoresIdleWithoutSpendingQueueAndBooksPendingInventory() public {
        vm.prank(depositor);
        facility.deposit(200, depositor);
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(adapter), true);
        vm.prank(CURATOR);
        facility.allocate(address(adapter), 150);
        vm.prank(depositor);
        facility.requestWithdraw(50);

        uint256 beforeAssets = facility.totalAssets();
        facility.fundLiquidation(100, address(this));

        assertEq(facility.idleAssets(), 50);
        assertEq(adapter.totalAssets(), 50);
        assertEq(facility.reservedQueueAssets(), 50);
        assertEq(facility.pendingFundedUsdc(), 100);
        assertEq(facility.totalAssets(), 50);

        vm.expectRevert(bytes("INVALID_AMOUNT"));
        facility.acquireInventory(address(collateral), 100, 101);
        facility.acquireInventory(address(collateral), 100, 100);

        assertEq(facility.inventoryAtAcquisitionCost(), 100);
        assertEq(facility.totalAssets(), beforeAssets);
    }

    function testAcquireInventoryRefundsUnusedFundingAndPreservesNav() public {
        vm.prank(depositor);
        facility.deposit(200, depositor);
        vm.prank(CURATOR);
        facility.setAdapterAllowed(address(adapter), true);
        vm.prank(CURATOR);
        facility.allocate(address(adapter), 150);
        vm.prank(depositor);
        facility.requestWithdraw(50);

        uint256 beforeAssets = facility.totalAssets();
        facility.fundLiquidation(100, address(this));
        uint256 balanceAfterFunding = usdc.balanceOf(address(this));
        usdc.approve(address(facility), 40);

        facility.acquireInventory(address(collateral), 100, 60);

        assertEq(usdc.balanceOf(address(this)), balanceAfterFunding - 40);
        assertEq(facility.pendingFundedUsdc(), 0);
        assertEq(facility.pendingFundedBlock(), 0);
        assertEq(facility.inventoryAtAcquisitionCost(), 60);
        assertEq(facility.totalAssets(), beforeAssets);
        assertEq(facility.allowance(address(this), address(facility)), 0);
    }
}
