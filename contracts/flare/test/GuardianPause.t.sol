// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {RFQRouter} from "../src/RFQRouter.sol";
import {RFQSettlement} from "../src/RFQSettlement.sol";
import {FacilityAggregator} from "../src/FacilityAggregator.sol";
import {LiquidityFacility} from "../src/LiquidityFacility.sol";
import {ConfidentialRFQInstructionSender} from "../src/ConfidentialRFQInstructionSender.sol";
import {NavProofRegistry, FtsoRiskGuard} from "../src/ProofGuards.sol";

contract GuardianPauseTest is TestBase {
    address private guardian = address(0xCAFE);

    function testRouterGuardianCanOnlyPause() public {
        RFQRouter router = new RFQRouter();
        router.setGuardian(guardian);
        vm.prank(guardian);
        router.guardianPause();
        assertTrue(router.paused());
        vm.expectRevert(bytes("ONLY_OWNER"));
        vm.prank(guardian);
        router.setPaused(false);
        vm.expectRevert(bytes("ONLY_GUARDIAN"));
        router.guardianPause();
    }

    function testSettlementGuardianBlocksFillAndCannotUnpause() public {
        RFQSettlement settlement = new RFQSettlement();
        settlement.setGuardian(guardian);
        vm.prank(guardian);
        settlement.guardianPause();
        assertTrue(settlement.paused());
        vm.expectRevert(bytes("SETTLEMENT_PAUSED"));
        settlement.fillWithEligibility(
            RFQSettlement.Order({
                maker: address(this),
                taker: address(this),
                executor: address(0),
                sellToken: address(0x1),
                buyToken: address(0x2),
                sellAmount: 1,
                minBuyAmount: 1,
                expiry: type(uint256).max,
                nonce: 1,
                pairSalt: bytes32(uint256(1)),
                contextCommitment: bytes32(0),
                orderType: 1,
                fillMode: 0,
                feeBps: 0
            }),
            1,
            1,
            "",
            bytes32(0),
            0,
            0,
            bytes32(0)
        );
        vm.expectRevert(bytes("ONLY_OWNER"));
        vm.prank(guardian);
        settlement.setPaused(false);
    }

    function testFacilityAndAggregatorGuardiansPauseOnlyTheirScope() public {
        LiquidityFacility facility = new LiquidityFacility(address(0xBEEF));
        facility.setGuardian(guardian);
        vm.prank(guardian);
        facility.guardianPause();
        assertTrue(facility.paused());
        assertEq(facility.maxDeposit(address(this)), 0);
        vm.expectRevert(bytes("ONLY_OWNER"));
        vm.prank(guardian);
        facility.setPaused(false);

        FacilityAggregator aggregator = new FacilityAggregator();
        aggregator.registerFacility(address(facility));
        aggregator.setGuardian(guardian);
        vm.prank(guardian);
        aggregator.guardianPauseFacility(address(facility));
        (bool active, uint256 output) = aggregator.quote(address(facility), address(0xBEEF), 1, 1);
        assertTrue(!active);
        assertEq(output, 0);
        vm.expectRevert(bytes("ONLY_OWNER"));
        vm.prank(guardian);
        aggregator.setPaused(address(facility), false);
    }

    function testFccAndProofGuardiansBlockAcceptingNewData() public {
        ConfidentialRFQInstructionSender sender = new ConfidentialRFQInstructionSender();
        sender.setGuardian(guardian);
        vm.prank(guardian);
        sender.guardianPause();
        bytes32 opType = sender.OP_RFQ();
        bytes32 command = sender.COMMAND_CREATE();
        vm.expectRevert(bytes("FCC_PAUSED"));
        sender.dispatch(opType, command, bytes32(uint256(1)), bytes32(uint256(2)), 1);
        vm.expectRevert(bytes("ONLY_OWNER"));
        vm.prank(guardian);
        sender.setPaused(false);

        NavProofRegistry registry = new NavProofRegistry();
        registry.setGuardian(guardian);
        vm.prank(guardian);
        registry.guardianPause();
        vm.expectRevert(bytes("NAV_PAUSED"));
        registry.submit(address(0xBEEF), bytes32(uint256(1)), 1, 0, 1, 2, address(this), true);

        FtsoRiskGuard ftso = new FtsoRiskGuard();
        ftso.configure(bytes32("USDX/USD"), 100, 50);
        ftso.setGuardian(guardian);
        vm.prank(guardian);
        ftso.guardianPause();
        vm.expectRevert(bytes("FTSO_PAUSED"));
        ftso.assertUsable(bytes32("USDX/USD"), 1_000_000, -6, 1, 1_000_000, -6);
    }
}
