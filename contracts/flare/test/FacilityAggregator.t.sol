// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {FacilityAggregator} from "../src/FacilityAggregator.sol";

contract MockFacilityQuote {
    uint256 public quoteValue;
    bool public shouldRevert;

    constructor(uint256 value) {
        quoteValue = value;
    }

    function quote(address, uint256, uint256) external view returns (uint256) {
        require(!shouldRevert, "QUOTE_FAILED");
        return quoteValue;
    }

    function setRevert(bool value) external {
        shouldRevert = value;
    }
}

contract FacilityAggregatorTest is TestBase {
    FacilityAggregator private aggregator;
    MockFacilityQuote private facility;

    function setUp() public {
        aggregator = new FacilityAggregator();
        facility = new MockFacilityQuote(123);
        aggregator.registerFacility(address(facility));
    }

    function testAggregatesActiveFacilityAndExcludesPausedOrRevoked() public {
        (bool active, uint256 quote) = aggregator.quote(address(facility), address(0xBEEF), 100, 1);
        assertTrue(active);
        assertEq(quote, 123);
        aggregator.setPaused(address(facility), true);
        (active,) = aggregator.quote(address(facility), address(0xBEEF), 100, 1);
        assertTrue(!active);
        aggregator.setPaused(address(facility), false);
        aggregator.revokeFacility(address(facility));
        (active,) = aggregator.quote(address(facility), address(0xBEEF), 100, 1);
        assertTrue(!active);
    }

    function testQuoteFailureDoesNotBreakTheAggregator() public {
        facility.setRevert(true);
        (bool active, uint256 quote) = aggregator.quote(address(facility), address(0xBEEF), 100, 1);
        assertTrue(!active);
        assertEq(quote, 0);
    }

    function testEnumeratesRegisteredFacilitiesAndRejectsDuplicateRegistration() public {
        assertEq(aggregator.facilityCount(), 1);
        assertEq(aggregator.facilityAt(0), address(facility));
        vm.expectRevert(bytes("FACILITY_EXISTS"));
        aggregator.registerFacility(address(facility));
    }

    function testQuoteAllReturnsOnlyActiveSuccessfulFacilities() public {
        MockFacilityQuote second = new MockFacilityQuote(456);
        aggregator.registerFacility(address(second));

        (address[] memory sources, uint256[] memory quotes) = aggregator.quoteAll(address(0xBEEF), 100, 1);
        assertEq(sources.length, 2);
        assertEq(quotes.length, 2);
        assertEq(sources[0], address(facility));
        assertEq(quotes[0], 123);
        assertEq(sources[1], address(second));
        assertEq(quotes[1], 456);

        facility.setRevert(true);
        (sources, quotes) = aggregator.quoteAll(address(0xBEEF), 100, 1);
        assertEq(sources.length, 1);
        assertEq(sources[0], address(second));
        assertEq(quotes[0], 456);
    }
}
