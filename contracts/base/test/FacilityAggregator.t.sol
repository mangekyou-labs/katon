// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { FacilityAggregator } from "../src/FacilityAggregator.sol";
import { IFacilityAggregator } from "../src/IFacilityAggregator.sol";
import { LiquidityFacility } from "../src/LiquidityFacility.sol";
import { MockERC20 } from "./MockERC20.sol";
import { TestBase } from "./TestBase.sol";

contract RevertingFacility {
    address public immutable asset;

    constructor(address asset_) {
        asset = asset_;
    }

    function quoteUsdcCapacity() external pure returns (uint256) {
        revert("QUOTE_FAILED");
    }

    function haircutWad() external pure returns (uint256) {
        return 0;
    }

    function fundLiquidation(uint256, address) external pure returns (uint256) {
        revert("FILL_FAILED");
    }
}

contract FacilityAggregatorTest is TestBase {
    address internal constant ROUTER = address(0xA66);
    address internal constant CURATOR = address(0xC0A7);
    address internal constant EXECUTOR = address(0xEceC);
    address internal constant GUARDIAN = address(0x6AAD);
    address internal constant COLLATERAL = address(0xB20);
    address internal depositor = address(0xD0);
    address internal receiver = address(0xB0B);

    MockERC20 internal usdc;
    LiquidityFacility internal facility;
    FacilityAggregator internal aggregator;

    function setUp() public {
        usdc = new MockERC20();
        facility = new LiquidityFacility(address(usdc), CURATOR, EXECUTOR, GUARDIAN);
        aggregator = new FacilityAggregator(ROUTER);
        usdc.mint(depositor, 100);
        vm.prank(depositor);
        usdc.approve(address(facility), 100);
        vm.prank(depositor);
        facility.deposit(100, depositor);
    }

    function testRegisterEnumerateAndQuoteFiltersAssets() public {
        address[] memory assets = new address[](1);
        assets[0] = COLLATERAL;
        aggregator.registerFacility(CURATOR, address(facility), assets);

        assertEq(aggregator.facilityCount(), 1);
        assertEq(aggregator.facilityAt(0), address(facility));

        IFacilityAggregator.FacilityQuote[] memory quotes =
            aggregator.quote(address(usdc), COLLATERAL, 50);
        assertEq(quotes.length, 1);
        assertEq(quotes[0].facility, address(facility));
        assertEq(quotes[0].quoteUsdc, 100);
        assertEq(quotes[0].haircutWad, 0);
        assertEq(quotes[0].snapshotBlock, block.number);

        quotes = aggregator.quote(address(0xBAD), COLLATERAL, 50);
        assertEq(quotes.length, 0);
        quotes = aggregator.quote(address(usdc), address(0xCAFE), 50);
        assertEq(quotes.length, 0);
    }

    function testPausedAndRevokedFacilitiesAreOmitted() public {
        aggregator.registerFacility(CURATOR, address(facility), new address[](0));
        aggregator.pauseFacility(address(facility));
        assertEq(aggregator.quote(address(usdc), COLLATERAL, 1).length, 0);

        aggregator.revokeFacility(address(facility));
        assertEq(aggregator.quote(address(usdc), COLLATERAL, 1).length, 0);
    }

    function testRevertingSiblingDoesNotFailQuoteBatch() public {
        RevertingFacility revertingFacility = new RevertingFacility(address(usdc));
        aggregator.registerFacility(CURATOR, address(revertingFacility), new address[](0));
        aggregator.registerFacility(CURATOR, address(facility), new address[](0));

        IFacilityAggregator.FacilityQuote[] memory quotes =
            aggregator.quote(address(usdc), COLLATERAL, 50);
        assertEq(quotes.length, 1);
        assertEq(quotes[0].facility, address(facility));
    }

    function testFillIsRouterGatedAndPassesThroughToFacility() public {
        aggregator.registerFacility(CURATOR, address(facility), new address[](0));
        facility.setRouter(address(aggregator));

        vm.prank(ROUTER);
        uint256 funded = aggregator.fill(address(facility), 40, receiver);

        assertEq(funded, 40);
        assertEq(usdc.balanceOf(receiver), 40);
    }
}
