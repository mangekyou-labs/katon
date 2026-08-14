// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFacilityQuote {
    function quote(address rwa, uint256 amount, uint256 decisionBlock) external view returns (uint256 output);
}

contract FacilityAggregator {
    struct FacilityState {
        bool registered;
        bool paused;
        bool revoked;
    }

    address public owner;
    mapping(address facility => FacilityState) public facilities;
    address[] private facilityList;
    address public guardian;

    event FacilityConfigured(address indexed facility, bool registered, bool paused, bool revoked);

    constructor() {
        owner = msg.sender;
    }

    function initialize(address owner_) external {
        require(owner == address(0), "ALREADY_INITIALIZED");
        require(owner_ != address(0), "OWNER_REQUIRED");
        owner = owner_;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_REQUIRED");
        owner = newOwner;
    }

    function setGuardian(address guardian_) external {
        require(msg.sender == owner, "ONLY_OWNER");
        guardian = guardian_;
    }

    function guardianPauseFacility(address facility) external {
        require(msg.sender == guardian, "ONLY_GUARDIAN");
        FacilityState storage state = facilities[facility];
        require(state.registered && !state.revoked, "FACILITY_UNKNOWN");
        state.paused = true;
        emit FacilityConfigured(facility, state.registered, true, state.revoked);
    }

    function registerFacility(address facility) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(facility != address(0), "FACILITY_REQUIRED");
        require(!facilities[facility].registered, "FACILITY_EXISTS");
        facilities[facility] = FacilityState(true, false, false);
        facilityList.push(facility);
        emit FacilityConfigured(facility, true, false, false);
    }

    function facilityCount() external view returns (uint256) {
        return facilityList.length;
    }

    function facilityAt(uint256 index) external view returns (address) {
        require(index < facilityList.length, "FACILITY_INDEX");
        return facilityList[index];
    }

    function setPaused(address facility, bool paused) external {
        require(msg.sender == owner, "ONLY_OWNER");
        FacilityState storage state = facilities[facility];
        require(state.registered && !state.revoked, "FACILITY_UNKNOWN");
        state.paused = paused;
        emit FacilityConfigured(facility, state.registered, paused, state.revoked);
    }

    function revokeFacility(address facility) external {
        require(msg.sender == owner, "ONLY_OWNER");
        FacilityState storage state = facilities[facility];
        require(state.registered, "FACILITY_UNKNOWN");
        state.revoked = true;
        state.paused = true;
        emit FacilityConfigured(facility, state.registered, true, true);
    }

    function quote(address facility, address rwa, uint256 amount, uint256 decisionBlock)
        external
        view
        returns (bool active, uint256 output)
    {
        FacilityState memory state = facilities[facility];
        if (!state.registered || state.paused || state.revoked) return (false, 0);
        try IFacilityQuote(facility).quote(rwa, amount, decisionBlock) returns (uint256 value) {
            return (true, value);
        } catch {
            return (false, 0);
        }
    }

    function quoteAll(address rwa, uint256 amount, uint256 decisionBlock)
        external
        view
        returns (address[] memory activeFacilities, uint256[] memory outputs)
    {
        address[] memory sources = new address[](facilityList.length);
        uint256[] memory values = new uint256[](facilityList.length);
        uint256 count;
        for (uint256 i = 0; i < facilityList.length; i++) {
            address facility = facilityList[i];
            (bool active, uint256 output) = this.quote(facility, rwa, amount, decisionBlock);
            if (!active || output == 0) continue;
            sources[count] = facility;
            values[count] = output;
            count++;
        }
        activeFacilities = new address[](count);
        outputs = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            activeFacilities[i] = sources[i];
            outputs[i] = values[i];
        }
    }
}
