// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFacilityAggregator {
    struct FacilityQuote {
        address facility;
        uint256 quoteUsdc;
        uint256 haircutWad;
        uint256 snapshotBlock;
    }

    function registerFacility(address curator, address facility, address[] calldata assets) external;

    function pauseFacility(address facility) external;

    function revokeFacility(address facility) external;

    function facilityCount() external view returns (uint256);

    function facilityAt(uint256 index) external view returns (address);

    function quote(address debtAsset, address collateralAsset, uint256 repayAssets)
        external
        view
        returns (FacilityQuote[] memory);

    function fill(address facility, uint256 repayAssets, address recipient)
        external
        returns (uint256 fundedUsdc);
}
