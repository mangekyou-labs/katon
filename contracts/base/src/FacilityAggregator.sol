// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IFacilityAggregator } from "./IFacilityAggregator.sol";
import { ILiquidityFacility } from "./ILiquidityFacility.sol";

contract FacilityAggregator is IFacilityAggregator {
    struct FacilityRecord {
        address curator;
        bool paused;
        bool revoked;
        address[] assets;
    }

    address public immutable admin;
    address public immutable router;
    mapping(address => FacilityRecord) public facilities;
    mapping(address => bool) public registered;
    address[] private _facilityList;

    event FacilityRegistered(address indexed curator, address indexed facility);
    event FacilityPaused(address indexed facility);
    event FacilityRevoked(address indexed facility);

    modifier onlyAdmin() {
        require(msg.sender == admin, "UNAUTHORIZED");
        _;
    }

    constructor(address router_) {
        require(router_ != address(0), "INVALID_ROUTER");
        admin = msg.sender;
        router = router_;
    }

    function registerFacility(address curator, address facility, address[] calldata assets)
        external
        onlyAdmin
    {
        require(curator != address(0) && facility != address(0), "INVALID_FACILITY");
        require(!registered[facility], "FACILITY_EXISTS");
        FacilityRecord storage record = facilities[facility];
        record.curator = curator;
        for (uint256 i = 0; i < assets.length; i++) {
            require(assets[i] != address(0), "INVALID_ASSET");
            record.assets.push(assets[i]);
        }
        registered[facility] = true;
        _facilityList.push(facility);
        emit FacilityRegistered(curator, facility);
    }

    function pauseFacility(address facility) external onlyAdmin {
        require(registered[facility], "UNKNOWN_FACILITY");
        facilities[facility].paused = true;
        emit FacilityPaused(facility);
    }

    function revokeFacility(address facility) external onlyAdmin {
        require(registered[facility], "UNKNOWN_FACILITY");
        facilities[facility].revoked = true;
        facilities[facility].paused = true;
        emit FacilityRevoked(facility);
    }

    function facilityCount() external view returns (uint256) {
        return _facilityList.length;
    }

    function facilityAt(uint256 index) external view returns (address) {
        require(index < _facilityList.length, "INDEX_OUT_OF_BOUNDS");
        return _facilityList[index];
    }

    function quote(address debtAsset, address collateralAsset, uint256 repayAssets)
        external
        view
        returns (FacilityQuote[] memory quotes)
    {
        repayAssets;
        quotes = new FacilityQuote[](_facilityList.length);
        uint256 count;
        for (uint256 i = 0; i < _facilityList.length; i++) {
            address facility = _facilityList[i];
            FacilityRecord storage record = facilities[facility];
            if (
                record.paused || record.revoked
                    || !_matchesCollateral(record.assets, collateralAsset)
            ) continue;

            address facilityAsset;
            try ILiquidityFacility(facility).asset() returns (address value) {
                facilityAsset = value;
            } catch {
                continue;
            }
            if (facilityAsset != debtAsset) continue;

            uint256 capacity;
            try ILiquidityFacility(facility).quoteUsdcCapacity() returns (uint256 value) {
                capacity = value;
            } catch {
                continue;
            }
            if (capacity == 0) continue;

            uint256 haircut;
            try ILiquidityFacility(facility).haircutWad() returns (uint256 value) {
                haircut = value;
            } catch {
                continue;
            }
            quotes[count++] = FacilityQuote({
                facility: facility,
                quoteUsdc: capacity,
                haircutWad: haircut,
                snapshotBlock: block.number
            });
        }
        assembly {
            mstore(quotes, count)
        }
    }

    function fill(address facility, uint256 repayAssets, address recipient)
        external
        returns (uint256 fundedUsdc)
    {
        require(msg.sender == router, "UNAUTHORIZED");
        FacilityRecord storage record = facilities[facility];
        require(registered[facility] && !record.paused && !record.revoked, "FACILITY_UNAVAILABLE");
        return ILiquidityFacility(facility).fundLiquidation(repayAssets, recipient);
    }

    function _matchesCollateral(address[] storage assets, address collateralAsset)
        private
        view
        returns (bool)
    {
        if (assets.length == 0) return true;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == collateralAsset) return true;
        }
        return false;
    }
}
