// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {MorphoYieldAdapter} from "../src/adapters/MorphoYieldAdapter.sol";
import {KineticYieldAdapter} from "../src/adapters/KineticYieldAdapter.sol";
import {ClearpoolYieldAdapter} from "../src/adapters/ClearpoolYieldAdapter.sol";
import {MorphoLiquidationAdapter} from "../src/adapters/MorphoLiquidationAdapter.sol";
import {KineticLiquidationAdapter} from "../src/adapters/KineticLiquidationAdapter.sol";
import {MockMorphoVault} from "../src/adapters/mocks/MockMorphoVault.sol";
import {MockKineticMarket} from "../src/adapters/mocks/MockKineticMarket.sol";
import {MockClearpoolTPool} from "../src/adapters/mocks/MockClearpoolTPool.sol";
import {MockLendingMarket} from "../src/adapters/mocks/MockLendingMarket.sol";
import {
    MockKineticComptroller,
    MockKineticLiquidationMarket
} from "../src/adapters/mocks/MockKineticLiquidationMarket.sol";

contract AdapterToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public transferBps = 10_000;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setTransferBps(uint256 value) external {
        require(value <= 10_000, "BPS");
        transferBps = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += (amount * transferBps) / 10_000;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev T4.3–T4.7 interface-faithful venue adapters (mock venues; not verified mainnet deployments).
contract VenueAdaptersTest is TestBase {
    address private facility = address(0xFAC1);
    address private recipient = address(0xCAFE);
    bytes32 private constant MARKET_ID = keccak256("market-1");
    bytes32 private constant POSITION = keccak256("position-1");
    address private constant KINETIC_BORROWER = address(0xB0B);
    bytes32 private constant KINETIC_POSITION = bytes32(uint256(uint160(KINETIC_BORROWER)));

    AdapterToken private usdx;
    AdapterToken private rwa;
    AdapterToken private wrongAsset;

    function setUp() public {
        usdx = new AdapterToken();
        rwa = new AdapterToken();
        wrongAsset = new AdapterToken();
    }

    function testMorphoYieldDepositWithdrawIsFacilityScopedAndLiquidityAware() public {
        MockMorphoVault vault = new MockMorphoVault(address(usdx));
        MorphoYieldAdapter adapter = new MorphoYieldAdapter(facility, address(usdx), address(vault), MARKET_ID);

        usdx.mint(facility, 1_000 ether);
        vm.prank(facility);
        usdx.transfer(address(adapter), 400 ether);
        vm.prank(facility);
        assertEq(adapter.deposit(400 ether), 400 ether);
        assertEq(adapter.totalAssets(), 400 ether);
        assertEq(adapter.maxWithdraw(), 400 ether);
        assertEq(usdx.allowance(address(adapter), address(vault)), 0);

        vm.prank(facility);
        assertEq(adapter.withdraw(150 ether, recipient), 150 ether);
        assertEq(usdx.balanceOf(recipient), 150 ether);
        assertEq(adapter.totalAssets(), 250 ether);

        vm.expectRevert(bytes("ADAPTER_CALLER"));
        adapter.deposit(1 ether);
    }

    function testMorphoYieldValuesRealVaultSharesInsteadOfAssumingOneToOne() public {
        MockMorphoVault vault = new MockMorphoVault(address(usdx));
        vault.setAssetsPerShare(2e18);
        MorphoYieldAdapter adapter = new MorphoYieldAdapter(facility, address(usdx), address(vault), MARKET_ID);

        usdx.mint(facility, 200 ether);
        vm.prank(facility);
        usdx.transfer(address(adapter), 200 ether);
        vm.prank(facility);
        assertEq(adapter.deposit(200 ether), 200 ether);

        assertEq(vault.balanceOf(address(adapter)), 100 ether);
        assertEq(adapter.totalAssets(), 200 ether);
        assertEq(adapter.maxWithdraw(), 200 ether);
    }

    function testKineticYieldUsesExchangeRateValuationAndCashCap() public {
        MockKineticMarket market = new MockKineticMarket(address(usdx));
        market.setExchangeRate(2e18);
        KineticYieldAdapter adapter = new KineticYieldAdapter(facility, address(usdx), address(market), MARKET_ID);

        usdx.mint(facility, 500 ether);
        vm.prank(facility);
        usdx.transfer(address(adapter), 200 ether);
        vm.prank(facility);
        adapter.deposit(200 ether);
        // 200 assets -> 100 receipt shares at 2e18 exchange rate; totalAssets values at rate.
        assertEq(adapter.totalAssets(), 200 ether);
        assertEq(usdx.allowance(address(adapter), address(market)), 0);

        market.setCash(50 ether);
        assertEq(adapter.maxWithdraw(), 50 ether);
        vm.prank(facility);
        assertEq(adapter.withdraw(50 ether, recipient), 50 ether);
    }

    function testKineticYieldRevertsOnMarketErrorCodesAndClearsApproval() public {
        MockKineticMarket market = new MockKineticMarket(address(usdx));
        KineticYieldAdapter adapter = new KineticYieldAdapter(facility, address(usdx), address(market), MARKET_ID);

        usdx.mint(facility, 20 ether);
        vm.prank(facility);
        usdx.transfer(address(adapter), 20 ether);

        market.setMintError(7);
        vm.prank(facility);
        vm.expectRevert(bytes("KINETIC_MINT"));
        adapter.deposit(10 ether);

        market.setMintError(0);
        vm.prank(facility);
        adapter.deposit(10 ether);
        assertEq(usdx.allowance(address(adapter), address(market)), 0);

        market.setRedeemError(8);
        vm.prank(facility);
        vm.expectRevert(bytes("KINETIC_REDEEM"));
        adapter.withdraw(5 ether, recipient);
    }

    function testClearpoolYieldRejectsNonUsdxAsset() public {
        MockClearpoolTPool pool = new MockClearpoolTPool(address(usdx));
        ClearpoolYieldAdapter ok = new ClearpoolYieldAdapter(facility, address(usdx), address(pool), MARKET_ID);
        assertEq(ok.asset(), address(usdx));

        vm.expectRevert(bytes("CLEARPOOL_USDX_ONLY"));
        new ClearpoolYieldAdapter(facility, address(wrongAsset), address(pool), MARKET_ID);
    }

    function testClearpoolYieldUsesAuditedTPoolSelectorsAndShareBalance() public {
        MockClearpoolTPool pool = new MockClearpoolTPool(address(usdx));
        ClearpoolYieldAdapter adapter =
            new ClearpoolYieldAdapter(facility, address(usdx), address(pool), MARKET_ID);

        usdx.mint(facility, 400 ether);
        vm.prank(facility);
        usdx.transfer(address(adapter), 400 ether);
        vm.prank(facility);
        assertEq(adapter.deposit(400 ether), 400 ether);

        assertEq(pool.balanceOf(address(adapter)), 400 ether);
        assertEq(adapter.totalAssets(), 400 ether);
        assertEq(adapter.maxWithdraw(), 400 ether);
        assertEq(usdx.allowance(address(adapter), address(pool)), 0);

        vm.prank(facility);
        assertEq(adapter.withdraw(150 ether, recipient), 150 ether);
        assertEq(usdx.balanceOf(recipient), 150 ether);
        assertEq(pool.balanceOf(address(adapter)), 250 ether);
        assertEq(adapter.totalAssets(), 250 ether);
    }

    function testClearpoolYieldCapsWithdrawalByPoolCashAndPreservesShares() public {
        MockClearpoolTPool pool = new MockClearpoolTPool(address(usdx));
        ClearpoolYieldAdapter adapter =
            new ClearpoolYieldAdapter(facility, address(usdx), address(pool), MARKET_ID);

        usdx.mint(facility, 400 ether);
        vm.prank(facility);
        usdx.transfer(address(adapter), 400 ether);
        vm.prank(facility);
        adapter.deposit(400 ether);

        pool.drainCash(address(0xdead), 300 ether);
        assertEq(adapter.maxWithdraw(), 100 ether);
        vm.prank(facility);
        vm.expectRevert(bytes("LIQUIDITY"));
        adapter.withdraw(101 ether, recipient);
        assertEq(pool.balanceOf(address(adapter)), 400 ether);

        vm.prank(facility);
        assertEq(adapter.withdraw(100 ether, recipient), 100 ether);
        assertEq(usdx.balanceOf(recipient), 100 ether);
        assertEq(pool.balanceOf(address(adapter)), 300 ether);
        assertEq(adapter.maxWithdraw(), 0);
    }

    function testMorphoLiquidationEnforcesBindingHealthAndCloseFactor() public {
        MockLendingMarket market = new MockLendingMarket(address(usdx), address(rwa));
        market.configurePosition(POSITION, 1_000 ether, 1_500 ether, 9_000, 5_000);
        MorphoLiquidationAdapter adapter = new MorphoLiquidationAdapter(
            address(0x1111),
            address(market),
            POSITION,
            address(usdx),
            address(rwa),
            address(market)
        );

        usdx.mint(address(this), 500 ether);
        rwa.mint(address(market), 1_500 ether);
        usdx.approve(address(adapter), 500 ether);

        uint256 repaid = adapter.liquidate(
            address(0x1111),
            address(market),
            POSITION,
            address(usdx),
            address(rwa),
            500 ether,
            recipient,
            ""
        );
        assertEq(repaid, 500 ether);
        assertEq(rwa.balanceOf(recipient), 750 ether);

        // After partial liquidation: remaining debt 500, closeFactor 50% => max 250.
        usdx.mint(address(this), 300 ether);
        usdx.approve(address(adapter), 300 ether);
        vm.expectRevert(bytes("LIQUIDATION_CLOSE_FACTOR"));
        adapter.liquidate(
            address(0x1111),
            address(market),
            POSITION,
            address(usdx),
            address(rwa),
            300 ether,
            recipient,
            ""
        );
    }

    function testKineticLiquidationRedeemsMeasuredUnderlyingAndClearsApproval() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(usdx), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(rwa), address(comptroller));
        comptroller.setAccountLiquidity(KINETIC_BORROWER, 0, 0, 1 ether);
        comptroller.setCloseFactorMantissa(1e18);
        market.setBorrowBalance(KINETIC_BORROWER, 100 ether);
        market.setSeizeTokens(75 ether);
        collateralMarket.setExchangeRateMantissa(2e18);
        collateralMarket.mintCollateral(KINETIC_BORROWER, 75 ether);
        rwa.mint(address(collateralMarket), 150 ether);
        KineticLiquidationAdapter adapter = new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            address(collateralMarket)
        );

        usdx.mint(address(this), 100 ether);
        usdx.approve(address(adapter), 100 ether);
        assertEq(
            adapter.liquidate(
                address(comptroller),
                address(market),
                KINETIC_POSITION,
                address(usdx),
                address(rwa),
                100 ether,
                recipient,
                ""
            ),
            100 ether
        );
        assertEq(rwa.balanceOf(recipient), 150 ether);
        assertEq(collateralMarket.balanceOf(address(adapter)), 0);
        assertEq(market.borrowBalanceStored(KINETIC_BORROWER), 0);
        assertEq(usdx.allowance(address(adapter), address(market)), 0);
    }

    function testKineticLiquidationRedeemFailureRollsBackAtomically() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(usdx), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(rwa), address(comptroller));
        comptroller.setAccountLiquidity(KINETIC_BORROWER, 0, 0, 1 ether);
        comptroller.setCloseFactorMantissa(1e18);
        market.setBorrowBalance(KINETIC_BORROWER, 100 ether);
        market.setSeizeTokens(75 ether);
        collateralMarket.setExchangeRateMantissa(2e18);
        collateralMarket.setRedeemError(9);
        collateralMarket.mintCollateral(KINETIC_BORROWER, 75 ether);
        rwa.mint(address(collateralMarket), 150 ether);
        KineticLiquidationAdapter adapter = new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            address(collateralMarket)
        );

        usdx.mint(address(this), 100 ether);
        usdx.approve(address(adapter), 100 ether);
        vm.expectRevert(bytes("KINETIC_REDEEM"));
        adapter.liquidate(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            100 ether,
            recipient,
            ""
        );

        assertEq(usdx.balanceOf(address(this)), 100 ether);
        assertEq(usdx.allowance(address(adapter), address(market)), 0);
        assertEq(market.borrowBalanceStored(KINETIC_BORROWER), 100 ether);
        assertEq(collateralMarket.balanceOf(KINETIC_BORROWER), 75 ether);
        assertEq(collateralMarket.balanceOf(address(adapter)), 0);
        assertEq(rwa.balanceOf(address(collateralMarket)), 150 ether);
        assertEq(rwa.balanceOf(recipient), 0);
    }

    function testKineticLiquidationRejectsMismatchedCollateralUnderlyingAtDeployment() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(usdx), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(rwa), address(comptroller));

        vm.expectRevert(bytes("KINETIC_COLLATERAL_UNDERLYING"));
        new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(wrongAsset),
            address(collateralMarket)
        );
    }

    function testKineticLiquidationRejectsHealthCloseFactorMarketErrorAndBindingMismatch() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(usdx), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(rwa), address(comptroller));
        comptroller.setAccountLiquidity(KINETIC_BORROWER, 0, 1 ether, 0);
        market.setBorrowBalance(KINETIC_BORROWER, 100 ether);
        market.setSeizeTokens(150 ether);
        collateralMarket.mintCollateral(KINETIC_BORROWER, 150 ether);
        KineticLiquidationAdapter adapter = new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            address(collateralMarket)
        );

        usdx.mint(address(this), 100 ether);
        usdx.approve(address(adapter), 100 ether);
        vm.expectRevert(bytes("LIQUIDATION_HEALTH"));
        adapter.liquidate(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            50 ether,
            recipient,
            ""
        );

        comptroller.setAccountLiquidity(KINETIC_BORROWER, 0, 0, 1 ether);
        comptroller.setCloseFactorMantissa(0.5e18);
        vm.expectRevert(bytes("LIQUIDATION_CLOSE_FACTOR"));
        adapter.liquidate(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            51 ether,
            recipient,
            ""
        );

        vm.expectRevert(bytes("LIQUIDATION_BINDING"));
        adapter.liquidate(
            address(0x9999),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            10 ether,
            recipient,
            ""
        );

        comptroller.setCloseFactorMantissa(1e18);
        market.setLiquidationError(17);
        vm.expectRevert(bytes("KINETIC_LIQUIDATE"));
        adapter.liquidate(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            10 ether,
            recipient,
            ""
        );
        assertEq(usdx.allowance(address(adapter), address(market)), 0);
    }

    function testKineticLiquidationRejectsRecipientMismatchAtomically() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(usdx), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(rwa), address(comptroller));
        comptroller.setAccountLiquidity(KINETIC_BORROWER, 0, 0, 1 ether);
        comptroller.setCloseFactorMantissa(1e18);
        market.setBorrowBalance(KINETIC_BORROWER, 100 ether);
        market.setSeizeTokens(150 ether);
        collateralMarket.mintCollateral(KINETIC_BORROWER, 150 ether);
        rwa.mint(address(collateralMarket), 150 ether);
        rwa.setTransferBps(9_000);
        KineticLiquidationAdapter adapter = new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            address(collateralMarket)
        );

        usdx.mint(address(this), 100 ether);
        usdx.approve(address(adapter), 100 ether);
        vm.expectRevert(bytes("COLLATERAL_RECIPIENT"));
        adapter.liquidate(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            100 ether,
            recipient,
            ""
        );

        assertEq(usdx.balanceOf(address(this)), 100 ether);
        assertEq(market.borrowBalanceStored(KINETIC_BORROWER), 100 ether);
        assertEq(collateralMarket.balanceOf(KINETIC_BORROWER), 150 ether);
        assertEq(rwa.balanceOf(recipient), 0);
    }

    function testKineticLiquidationRejectsComptrollerLiquidityErrorBeforeFunding() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(usdx), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(rwa), address(comptroller));
        comptroller.setAccountLiquidity(KINETIC_BORROWER, 7, 0, 1 ether);
        market.setBorrowBalance(KINETIC_BORROWER, 100 ether);
        KineticLiquidationAdapter adapter = new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            address(collateralMarket)
        );

        usdx.mint(address(this), 50 ether);
        usdx.approve(address(adapter), 50 ether);
        vm.expectRevert(bytes("KINETIC_LIQUIDITY"));
        adapter.liquidate(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            50 ether,
            recipient,
            ""
        );

        assertEq(usdx.balanceOf(address(this)), 50 ether);
        assertEq(usdx.balanceOf(address(adapter)), 0);
        assertEq(usdx.allowance(address(adapter), address(market)), 0);
        assertEq(market.borrowBalanceStored(KINETIC_BORROWER), 100 ether);
    }

    function testKineticLiquidationCloseFactorCalculationDoesNotOverflow() public {
        MockKineticComptroller comptroller = new MockKineticComptroller();
        MockKineticLiquidationMarket market = new MockKineticLiquidationMarket(address(usdx), address(comptroller));
        MockKineticLiquidationMarket collateralMarket =
            new MockKineticLiquidationMarket(address(rwa), address(comptroller));
        uint256 debtOutstanding = type(uint256).max;
        uint256 maxRepay = debtOutstanding / 2;
        comptroller.setAccountLiquidity(KINETIC_BORROWER, 0, 0, 1);
        comptroller.setCloseFactorMantissa(0.5e18);
        market.setBorrowBalance(KINETIC_BORROWER, debtOutstanding);
        market.setSeizeTokens(1);
        collateralMarket.mintCollateral(KINETIC_BORROWER, 1);
        rwa.mint(address(collateralMarket), 1);
        KineticLiquidationAdapter adapter = new KineticLiquidationAdapter(
            address(comptroller),
            address(market),
            KINETIC_POSITION,
            address(usdx),
            address(rwa),
            address(collateralMarket)
        );

        usdx.mint(address(this), maxRepay);
        usdx.approve(address(adapter), maxRepay);
        assertEq(
            adapter.liquidate(
                address(comptroller),
                address(market),
                KINETIC_POSITION,
                address(usdx),
                address(rwa),
                maxRepay,
                recipient,
                ""
            ),
            maxRepay
        );
        assertEq(market.borrowBalanceStored(KINETIC_BORROWER), debtOutstanding - maxRepay);
        assertEq(rwa.balanceOf(recipient), 1);
    }

    function testYieldAdaptersPauseBlocksDepositAndWithdraw() public {
        MockMorphoVault vault = new MockMorphoVault(address(usdx));
        MorphoYieldAdapter adapter = new MorphoYieldAdapter(facility, address(usdx), address(vault), MARKET_ID);
        adapter.pause();
        usdx.mint(facility, 10 ether);
        vm.prank(facility);
        usdx.transfer(address(adapter), 10 ether);
        vm.prank(facility);
        vm.expectRevert(bytes("ADAPTER_PAUSED"));
        adapter.deposit(10 ether);
    }
}
