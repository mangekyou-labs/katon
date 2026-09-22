// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { BaseEIP712 } from "../src/BaseEIP712.sol";
import { ILiquidationAdapter } from "../src/ILiquidationAdapter.sol";
import { IB20Guard } from "../src/IB20Guard.sol";
import { IOracleGuard } from "../src/IOracleGuard.sol";
import { IRFQRouter } from "../src/IRFQRouter.sol";
import { IRFQSettlement } from "../src/IRFQSettlement.sol";
import { IMorphoBlue } from "../src/adapters/MorphoYieldAdapter.sol";
import { AaveLiquidationAdapter } from "../src/adapters/AaveLiquidationAdapter.sol";
import { MorphoLiquidationAdapter } from "../src/adapters/MorphoLiquidationAdapter.sol";
import { EulerLiquidationAdapter } from "../src/adapters/EulerLiquidationAdapter.sol";
import { MockAavePool } from "./MockAavePool.sol";
import { MockERC20 } from "./MockERC20.sol";
import { MockEulerVault } from "./MockEulerVault.sol";
import { MockMorphoBlue } from "./MockMorphoBlue.sol";
import { RFQRouter } from "../src/RFQRouter.sol";
import { RFQSettlement } from "../src/RFQSettlement.sol";
import { TestBase } from "./TestBase.sol";

contract AdapterRouterOracleGuard is IOracleGuard {
    function configureFeed(address, address, uint256) external pure { }

    function setGracePeriod(uint256) external pure { }

    function requireFresh(address) external pure { }

    function snapshot(address) external pure returns (int256, uint256, uint8, bool, uint256, bool) {
        return (1, 1, 8, true, 1, false);
    }
}

contract AdapterRouterB20Guard is IB20Guard {
    function requireTransferAndSeizeLive(address) external pure { }

    function requireTransferAuthorized(address, address, address) external pure { }

    function multiplierWad(address) external pure returns (uint256) {
        return 1e18;
    }

    function scaledBalanceOf(address, address) external pure returns (uint256) {
        return 0;
    }
}

contract LiquidationAdaptersTest is TestBase {
    uint256 internal constant MAKER_KEY = 0xA11CE;
    address internal constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;

    MockERC20 internal usdc;
    MockERC20 internal collateral;
    MockAavePool internal aavePool;
    MockMorphoBlue internal morpho;
    MockEulerVault internal eulerDebt;
    MockEulerVault internal eulerCollateral;
    IMorphoBlue.MarketParams internal morphoParams;
    bytes32 internal constant AAVE_MARKET = bytes32(uint256(0xAA0E));
    bytes32 internal constant EULER_MARKET = bytes32(uint256(0xE11E));
    address internal recipient = address(0xBEEF);
    address internal borrower = address(0xB0BB);

    function setUp() public {
        usdc = new MockERC20();
        collateral = new MockERC20();
        aavePool = new MockAavePool(address(usdc), address(0));
        morpho = new MockMorphoBlue(address(usdc));
        eulerDebt = new MockEulerVault(address(usdc));
        eulerCollateral = new MockEulerVault(address(collateral));
        eulerDebt.setCollateralVault(address(eulerCollateral));
        morphoParams = IMorphoBlue.MarketParams({
            loanToken: address(usdc),
            collateralToken: address(collateral),
            oracle: address(0x01),
            irm: address(0x02),
            lltv: 8e17
        });
        usdc.mint(address(this), 1_000);
        vm.prank(address(this));
        usdc.approve(address(aavePool), 1_000);
    }

    function testAaveHappyPathConsumesDebtAndClearsAllowance() public {
        AaveLiquidationAdapter adapter = new AaveLiquidationAdapter(
            address(aavePool), address(usdc), address(collateral), AAVE_MARKET
        );
        collateral.mint(address(aavePool), 110);
        usdc.approve(address(adapter), 100);

        adapter.liquidate(_request(AAVE_MARKET, address(usdc), address(collateral), 100, 100));

        assertEq(collateral.balanceOf(recipient), 110);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.allowance(address(adapter), address(aavePool)), 0);
    }

    function testMorphoHappyPathUsesMarketIdAndClearsAllowance() public {
        MorphoLiquidationAdapter adapter =
            new MorphoLiquidationAdapter(address(morpho), morphoParams);
        collateral.mint(address(morpho), 110);
        usdc.approve(address(adapter), 100);

        adapter.liquidate(
            _request(
                keccak256(abi.encode(morphoParams)), address(usdc), address(collateral), 100, 100
            )
        );

        assertEq(collateral.balanceOf(recipient), 110);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.allowance(address(adapter), address(morpho)), 0);
    }

    function testEulerHappyPathRepaysInheritedDebtAndRedeemsCollateral() public {
        EulerLiquidationAdapter adapter = new EulerLiquidationAdapter(
            address(eulerDebt), address(eulerCollateral), address(usdc), EULER_MARKET
        );
        collateral.mint(address(eulerCollateral), 110);
        eulerCollateral.seedUnderlying(110);
        usdc.approve(address(adapter), 100);

        adapter.liquidate(_request(EULER_MARKET, address(usdc), address(collateral), 100, 100));

        assertEq(collateral.balanceOf(recipient), 110);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.allowance(address(adapter), address(eulerDebt)), 0);
    }

    function testEveryNamedAdapterRejectsTrailingCalldata() public {
        AaveLiquidationAdapter aave = new AaveLiquidationAdapter(
            address(aavePool), address(usdc), address(collateral), AAVE_MARKET
        );
        MorphoLiquidationAdapter morphoAdapter =
            new MorphoLiquidationAdapter(address(morpho), morphoParams);
        EulerLiquidationAdapter euler = new EulerLiquidationAdapter(
            address(eulerDebt), address(eulerCollateral), address(usdc), EULER_MARKET
        );
        ILiquidationAdapter.Request memory request =
            _request(AAVE_MARKET, address(usdc), address(collateral), 1, 0);
        _assertInvalidCalldata(address(aave), request);
        request.marketId = keccak256(abi.encode(morphoParams));
        _assertInvalidCalldata(address(morphoAdapter), request);
        request.marketId = EULER_MARKET;
        _assertInvalidCalldata(address(euler), request);
    }

    function testAssetMarketAndVenueGuards() public {
        AaveLiquidationAdapter zeroVenue =
            new AaveLiquidationAdapter(address(0), address(usdc), address(collateral), AAVE_MARKET);
        vm.expectRevert(bytes("INVALID_VENUE"));
        zeroVenue.liquidate(_request(AAVE_MARKET, address(usdc), address(collateral), 1, 0));

        AaveLiquidationAdapter adapter = new AaveLiquidationAdapter(
            address(aavePool), address(usdc), address(collateral), AAVE_MARKET
        );
        vm.expectRevert(bytes("UNSUPPORTED_ASSET"));
        new AaveLiquidationAdapter(address(aavePool), USDBC, address(collateral), AAVE_MARKET);

        vm.expectRevert(bytes("ASSET_MISMATCH"));
        adapter.liquidate(_request(AAVE_MARKET, address(0x1234), address(collateral), 1, 0));
        vm.expectRevert(bytes("COLLATERAL_MISMATCH"));
        adapter.liquidate(_request(AAVE_MARKET, address(usdc), address(0x1234), 1, 0));
        vm.expectRevert(bytes("MARKET_MISMATCH"));
        adapter.liquidate(_request(bytes32(uint256(1)), address(usdc), address(collateral), 1, 0));
    }

    function testVenueRevertLeavesAdapterAndVenueAllowancesZero() public {
        AaveLiquidationAdapter adapter = new AaveLiquidationAdapter(
            address(aavePool), address(usdc), address(collateral), AAVE_MARKET
        );
        aavePool.setReverting(true);
        usdc.approve(address(adapter), 100);
        vm.expectRevert(bytes("VENUE_REVERT"));
        adapter.liquidate(_request(AAVE_MARKET, address(usdc), address(collateral), 100, 0));
        assertEq(usdc.allowance(address(adapter), address(aavePool)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function testNamedAaveAdapterRunsThroughRouter() public {
        RFQSettlement settlement = new RFQSettlement(address(usdc));
        RFQRouter router = new RFQRouter();
        AdapterRouterOracleGuard oracleGuard = new AdapterRouterOracleGuard();
        AdapterRouterB20Guard b20Guard = new AdapterRouterB20Guard();
        router.setOracleGuard(address(oracleGuard));
        router.setB20Guard(address(b20Guard));
        settlement.setRouter(address(router));
        router.setSettlement(address(settlement), true);
        router.setMaxDecisionBlockAge(3);
        AaveLiquidationAdapter adapter = new AaveLiquidationAdapter(
            address(aavePool), address(usdc), address(collateral), AAVE_MARKET
        );
        router.setLiquidationAdapter(address(adapter), true);
        address maker = vm.addr(MAKER_KEY);
        usdc.mint(maker, 100);
        vm.prank(maker);
        usdc.approve(address(settlement), 100);
        collateral.mint(address(aavePool), 110);

        IRFQSettlement.LiquidationFundingOrder memory order = IRFQSettlement.LiquidationFundingOrder({
            maker: maker,
            signer: maker,
            debtAsset: address(usdc),
            collateralAsset: address(collateral),
            maxRepayAssets: 100,
            minCollateralOut: 100,
            fillMode: 0,
            expiry: block.timestamp + 1 days,
            salt: 1,
            feeLimitBps: 0,
            rfqId: bytes32(uint256(1)),
            venue: address(0),
            marketId: AAVE_MARKET
        });
        bytes memory signature = _sign(order, settlement);
        IRFQRouter.LiquidationRoutePlan memory plan = IRFQRouter.LiquidationRoutePlan({
            rfqId: order.rfqId,
            winner: maker,
            recipient: maker,
            borrower: borrower,
            deadline: block.timestamp + 1 days,
            source: IRFQRouter.FundingSource.LP,
            settlementOrFacility: address(settlement),
            liquidationAdapter: address(adapter),
            repayAssets: 100,
            minCollateralOutRfq: 100,
            minCollateralOutFunder: 100,
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            fundingPayload: abi.encode(order, signature)
        });

        vm.prank(maker);
        (uint256 repaid, uint256 seized, uint256 fee) = router.executeLiquidationRoute(plan);
        assertEq(repaid, 100);
        assertEq(seized, 110);
        assertEq(fee, 0);
        assertEq(collateral.balanceOf(maker), 110);
        assertEq(usdc.allowance(address(router), address(adapter)), 0);
    }

    function _request(
        bytes32 marketId,
        address debtAsset,
        address collateralAsset,
        uint256 repay,
        uint256 minOut
    ) internal view returns (ILiquidationAdapter.Request memory) {
        return ILiquidationAdapter.Request({
            marketId: marketId,
            borrower: borrower,
            debtAsset: debtAsset,
            collateralAsset: collateralAsset,
            maxRepayAssets: repay,
            minCollateralOut: minOut,
            recipient: recipient
        });
    }

    function _assertInvalidCalldata(address adapter, ILiquidationAdapter.Request memory request)
        internal
    {
        (bool ok, bytes memory data) = adapter.call(
            abi.encodeWithSelector(ILiquidationAdapter.liquidate.selector, request, hex"00")
        );
        assertTrue(!ok);
        assertTrue(
            keccak256(data)
                == keccak256(abi.encodeWithSignature("Error(string)", "INVALID_CALLDATA"))
        );
    }

    function _sign(IRFQSettlement.LiquidationFundingOrder memory order, RFQSettlement settlement)
        internal
        returns (bytes memory)
    {
        BaseEIP712.LiquidationFundingOrder memory typedOrder = BaseEIP712.LiquidationFundingOrder({
            maker: order.maker,
            signer: order.signer,
            debtAsset: order.debtAsset,
            collateralAsset: order.collateralAsset,
            maxRepayAssets: order.maxRepayAssets,
            minCollateralOut: order.minCollateralOut,
            fillMode: order.fillMode,
            expiry: order.expiry,
            salt: order.salt,
            feeLimitBps: order.feeLimitBps,
            rfqId: order.rfqId,
            venue: order.venue,
            marketId: order.marketId
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            MAKER_KEY,
            BaseEIP712.hashLiquidationFundingOrder(typedOrder, block.chainid, address(settlement))
        );
        return abi.encodePacked(r, s, v);
    }
}
