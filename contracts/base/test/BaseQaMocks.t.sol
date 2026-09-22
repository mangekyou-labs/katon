// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AaveLiquidationAdapter } from "../src/adapters/AaveLiquidationAdapter.sol";
import { B20Guard } from "../src/B20Guard.sol";
import { ILiquidationAdapter } from "../src/ILiquidationAdapter.sol";
import { OracleGuard } from "../src/OracleGuard.sol";
import {
    BaseQaAavePool,
    BaseQaB20,
    BaseQaERC20,
    BaseQaOracleFeed,
    BaseQaPolicyRegistry
} from "../src/qa/BaseQaMocks.sol";
import { TestBase } from "./TestBase.sol";

contract BaseQaMocksTest is TestBase {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant NOW = 1_000_000;

    BaseQaERC20 internal usdc;
    BaseQaB20 internal b20;

    function setUp() public {
        vm.warp(NOW);
        usdc = new BaseQaERC20();
        usdc.initialize("USD Coin", "USDC", 6);
        b20 = new BaseQaB20();
        b20.initialize("Mock B20", "MOCKB20", 18);
    }

    function testSixDecimalTokenCanBeEtchedThenInitializedOnce() public {
        assertEq(uint256(usdc.decimals()), 6);
        usdc.mint(address(this), 5_000_000);
        assertEq(usdc.balanceOf(address(this)), 5_000_000);
        vm.expectRevert(bytes("ALREADY_INITIALIZED"));
        usdc.initialize("other", "OTHER", 18);
    }

    function testPolicyOracleAndSequencerMocksSatisfyRealGuards() public {
        BaseQaPolicyRegistry registry = new BaseQaPolicyRegistry();
        BaseQaOracleFeed oracle = new BaseQaOracleFeed(false);
        BaseQaOracleFeed sequencer = new BaseQaOracleFeed(true);
        OracleGuard oracleGuard = new OracleGuard(address(sequencer), address(registry), 3_600);
        B20Guard b20Guard = new B20Guard(address(registry));
        oracleGuard.configureFeed(address(b20), address(oracle), 86_400);

        oracleGuard.requireFresh(address(b20));
        b20Guard.requireTransferAndSeizeLive(address(b20));
        b20Guard.requireTransferAuthorized(address(b20), address(this), address(0xBEEF));
        assertEq(b20Guard.multiplierWad(address(b20)), WAD);
    }

    function testInterfaceFaithfulAaveMockWorksThroughTheRealAdapter() public {
        bytes32 marketId = keccak256("BASE_QA_AAVE_MARKET");
        BaseQaAavePool pool = new BaseQaAavePool(address(usdc), address(b20), 11e17);
        AaveLiquidationAdapter adapter =
            new AaveLiquidationAdapter(address(pool), address(usdc), address(b20), marketId);
        usdc.mint(address(this), 1_000_000);
        usdc.approve(address(adapter), 1_000_000);

        (uint256 repaid, uint256 seized) = adapter.liquidate(
            ILiquidationAdapter.Request({
                marketId: marketId,
                borrower: address(0xB0B),
                debtAsset: address(usdc),
                collateralAsset: address(b20),
                maxRepayAssets: 1_000_000,
                minCollateralOut: 1e18,
                recipient: address(this)
            })
        );

        assertEq(repaid, 1_000_000);
        assertEq(seized, 11e17);
        assertEq(b20.balanceOf(address(this)), 11e17);
        assertEq(usdc.allowance(address(adapter), address(pool)), 0);
    }
}
