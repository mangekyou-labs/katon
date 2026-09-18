// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { BaseEIP712 } from "../src/BaseEIP712.sol";
import { IRFQSettlement } from "../src/IRFQSettlement.sol";
import { MockERC1271 } from "./MockERC1271.sol";
import { MockERC20 } from "./MockERC20.sol";
import { RFQSettlement } from "../src/RFQSettlement.sol";
import { TestBase } from "./TestBase.sol";

contract RFQSettlementTest is TestBase {
    uint256 internal constant MAKER_KEY = 0xA11CE;
    uint256 internal constant DELEGATE_KEY = 0xB0B;
    MockERC20 internal usdc;
    RFQSettlement internal settlement;
    address internal maker;
    address internal delegate;

    function setUp() public {
        usdc = new MockERC20();
        settlement = new RFQSettlement(address(usdc));
        settlement.setRouter(address(this));
        maker = vm.addr(MAKER_KEY);
        delegate = vm.addr(DELEGATE_KEY);
    }

    function testStandingOrderTracksCapacityAndOverfillReverts() public {
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, maker, 100, 1, 1);
        bytes memory signature = _sign(order, MAKER_KEY);
        usdc.mint(maker, 100);
        vm.prank(maker);
        MockERC20(address(usdc)).approve(address(settlement), 100);

        assertEq(_fundAndFinalize(order, signature, 40, address(0xBEEF)), 40);
        assertEq(settlement.filled(_hash(order)), 40);
        assertEq(usdc.balanceOf(address(this)), 40);
        assertEq(_fundAndFinalize(order, signature, 50, address(0xBEEF)), 50);
        assertEq(settlement.filled(_hash(order)), 90);

        vm.expectRevert(bytes("OVERFILL"));
        settlement.fundLiquidationOrder(_asInterface(order), signature, 11);
    }

    function testFillOrKillBelowMaxReverts() public {
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, maker, 100, 2, 0);
        bytes memory signature = _sign(order, MAKER_KEY);
        vm.expectRevert(bytes("FILL_OR_KILL"));
        settlement.fundLiquidationOrder(_asInterface(order), signature, 99);
    }

    function testMakerCancelAndPairSaltCancelBlockFills() public {
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, maker, 10, 3, 1);
        bytes memory signature = _sign(order, MAKER_KEY);
        usdc.mint(maker, 20);
        vm.prank(maker);
        MockERC20(address(usdc)).approve(address(settlement), 20);

        vm.prank(maker);
        settlement.cancelOrder(_hash(order));
        vm.expectRevert(bytes("CANCELLED"));
        settlement.fundLiquidationOrder(_asInterface(order), signature, 10);

        BaseEIP712.LiquidationFundingOrder memory otherOrder = _order(maker, maker, 10, 14, 1);
        bytes memory otherSignature = _sign(otherOrder, MAKER_KEY);
        vm.prank(delegate);
        settlement.cancelOrder(_hash(otherOrder));
        _fundAndFinalize(otherOrder, otherSignature, 10, address(this));

        BaseEIP712.LiquidationFundingOrder memory pairOrder = _order(maker, maker, 10, 9, 1);
        bytes memory pairSignature = _sign(pairOrder, MAKER_KEY);
        vm.prank(maker);
        settlement.cancelPairBelowSalt(address(usdc), address(0x222), 10);
        vm.expectRevert(bytes("SALT_CANCELLED"));
        settlement.fundLiquidationOrder(_asInterface(pairOrder), pairSignature, 10);
    }

    function testDelegatedSignerCanFillThenRevocationAndExpiryRevert() public {
        vm.prank(maker);
        settlement.registerOrderSigner(delegate);
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, delegate, 10, 5, 0);
        bytes memory signature = _sign(order, DELEGATE_KEY);
        usdc.mint(maker, 30);
        vm.prank(maker);
        MockERC20(address(usdc)).approve(address(settlement), 30);
        _fundAndFinalize(order, signature, 10, address(this));

        vm.prank(maker);
        settlement.revokeOrderSigner(delegate);
        BaseEIP712.LiquidationFundingOrder memory revoked = _order(maker, delegate, 10, 6, 0);
        vm.expectRevert(bytes("UNAUTHORIZED"));
        settlement.fundLiquidationOrder(_asInterface(revoked), _sign(revoked, DELEGATE_KEY), 10);

        BaseEIP712.LiquidationFundingOrder memory expiring = _order(maker, maker, 10, 7, 1);
        expiring.expiry = block.timestamp + 10;
        vm.warp(expiring.expiry + 1);
        vm.expectRevert(bytes("EXPIRED"));
        settlement.fundLiquidationOrder(_asInterface(expiring), _sign(expiring, MAKER_KEY), 10);
    }

    function testERC1271MagicAcceptedFalseAndRevertRejected() public {
        MockERC1271 wallet = new MockERC1271();
        wallet.approveToken(address(usdc), address(settlement), 30);
        usdc.mint(address(wallet), 30);
        BaseEIP712.LiquidationFundingOrder memory order =
            _order(address(wallet), address(wallet), 10, 8, 0);
        _fundAndFinalize(order, bytes("ignored"), 10, address(this));
        assertEq(usdc.balanceOf(address(this)), 10);

        wallet.setResponse(0xffffffff);
        BaseEIP712.LiquidationFundingOrder memory falseOrder =
            _order(address(wallet), address(wallet), 10, 9, 0);
        vm.expectRevert(bytes("UNAUTHORIZED"));
        settlement.fundLiquidationOrder(_asInterface(falseOrder), bytes("ignored"), 10);

        wallet.setResponse(0x1626ba7e);
        wallet.setShouldRevert(true);
        BaseEIP712.LiquidationFundingOrder memory reverting =
            _order(address(wallet), address(wallet), 10, 10, 0);
        vm.expectRevert(bytes("VALIDATOR_REVERT"));
        settlement.fundLiquidationOrder(_asInterface(reverting), bytes("ignored"), 10);
    }

    function testFeeGateHasNoSettlementFeeAndCapIsFiftyBps() public {
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, maker, 10, 11, 0);
        usdc.mint(maker, 10);
        vm.prank(maker);
        MockERC20(address(usdc)).approve(address(settlement), 10);
        assertEq(_fundAndFinalize(order, _sign(order, MAKER_KEY), 10, address(this)), 10);
        assertEq(usdc.balanceOf(address(this)), 10);

        settlement.setActiveFeeBps(1);
        BaseEIP712.LiquidationFundingOrder memory tooLow = _order(maker, maker, 10, 12, 0);
        vm.expectRevert(bytes("FEE_LIMIT"));
        settlement.fundLiquidationOrder(_asInterface(tooLow), _sign(tooLow, MAKER_KEY), 10);

        vm.expectRevert(bytes("FEE_CAP"));
        settlement.setActiveFeeBps(51);
    }

    function testWrongSignerAndNonRouterCallerRevertUnauthorized() public {
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, maker, 10, 13, 0);
        bytes memory signature = _sign(order, DELEGATE_KEY);
        vm.expectRevert(bytes("UNAUTHORIZED"));
        settlement.fundLiquidationOrder(_asInterface(order), signature, 10);

        settlement.setRouter(address(0xCAFE));
        vm.expectRevert(bytes("UNAUTHORIZED"));
        settlement.fundLiquidationOrder(_asInterface(order), _sign(order, MAKER_KEY), 10);
    }

    function testFundingTransfersMaximumWithoutBookingFillAndFinalizationBooksMeasuredValues() public {
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, maker, 100, 15, 1);
        order.debtAsset = address(usdc);
        bytes memory signature = _sign(order, MAKER_KEY);
        usdc.mint(maker, 100);
        vm.prank(maker);
        usdc.approve(address(settlement), 100);

        assertEq(
            settlement.fundLiquidationOrder(_asInterface(order), signature, 100),
            100
        );
        assertEq(settlement.filled(_hash(order)), 0);
        assertEq(usdc.balanceOf(address(this)), 100);

        settlement.finalizeLiquidationOrder(_asInterface(order), address(0xBEEF), 61, 73, 2);
        assertEq(settlement.filled(_hash(order)), 61);
    }

    function testFillOrKillFinalizationBelowMaximumRevertsAtomically() public {
        BaseEIP712.LiquidationFundingOrder memory order = _order(maker, maker, 100, 16, 0);
        order.debtAsset = address(usdc);
        bytes memory signature = _sign(order, MAKER_KEY);
        usdc.mint(maker, 100);
        vm.prank(maker);
        usdc.approve(address(settlement), 100);

        settlement.fundLiquidationOrder(_asInterface(order), signature, 100);
        vm.expectRevert(bytes("FILL_OR_KILL"));
        settlement.finalizeLiquidationOrder(_asInterface(order), address(this), 99, 100, 0);
        assertEq(settlement.filled(_hash(order)), 0);
    }

    function _order(
        address orderMaker,
        address signer,
        uint256 maxRepay,
        uint256 salt,
        uint8 fillMode
    ) internal view returns (BaseEIP712.LiquidationFundingOrder memory) {
        return BaseEIP712.LiquidationFundingOrder({
            maker: orderMaker,
            signer: signer,
            debtAsset: address(usdc),
            collateralAsset: address(0x222),
            maxRepayAssets: maxRepay,
            minCollateralOut: 0,
            fillMode: fillMode,
            expiry: block.timestamp + 1 days,
            salt: salt,
            feeLimitBps: 0,
            rfqId: bytes32(salt),
            venue: address(0),
            marketId: bytes32(uint256(0x99))
        });
    }

    function _hash(BaseEIP712.LiquidationFundingOrder memory order)
        internal
        view
        returns (bytes32)
    {
        return BaseEIP712.hashLiquidationFundingOrder(order, block.chainid, address(settlement));
    }

    function _fundAndFinalize(
        BaseEIP712.LiquidationFundingOrder memory order,
        bytes memory signature,
        uint256 funding,
        address recipient
    ) internal returns (uint256) {
        uint256 funded = settlement.fundLiquidationOrder(_asInterface(order), signature, funding);
        settlement.finalizeLiquidationOrder(
            _asInterface(order), recipient, funded, 0, 0
        );
        return funded;
    }

    function _sign(BaseEIP712.LiquidationFundingOrder memory order, uint256 privateKey)
        internal
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, _hash(order));
        return abi.encodePacked(r, s, v);
    }

    function _asInterface(BaseEIP712.LiquidationFundingOrder memory order)
        internal
        pure
        returns (IRFQSettlement.LiquidationFundingOrder memory)
    {
        return IRFQSettlement.LiquidationFundingOrder({
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
    }
}
