// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { BaseEIP712 } from "./BaseEIP712.sol";
import { IERC1271 } from "./IERC1271.sol";
import { IERC20 } from "./IERC20.sol";
import { IRFQSettlement } from "./IRFQSettlement.sol";

contract RFQSettlement is IRFQSettlement {
    bytes4 internal constant ERC1271_MAGICVALUE = 0x1626ba7e;
    uint16 public constant MAX_FEE_BPS = 50;

    address public immutable usdc;
    address public admin;
    address public router;
    uint16 public activeFeeBps;

    mapping(bytes32 => uint256) public filled;
    mapping(bytes32 => uint256) public override swapFilled;
    mapping(bytes32 => uint256) public pendingFunding;
    mapping(address => mapping(address => bool)) public orderSigners;
    mapping(address => mapping(bytes32 => bool)) public cancelled;
    mapping(bytes32 => uint256) public cancelledSalt;

    uint256 private _status = 1;

    modifier onlyAdmin() {
        require(msg.sender == admin, "UNAUTHORIZED");
        _;
    }

    modifier nonReentrant() {
        require(_status == 1, "REENTRANT");
        _status = 2;
        _;
        _status = 1;
    }

    constructor(address usdc_) {
        require(usdc_ != address(0), "INVALID_USDC");
        usdc = usdc_;
        admin = msg.sender;
    }

    function setRouter(address router_) external onlyAdmin {
        require(router_ != address(0), "INVALID_ROUTER");
        router = router_;
    }

    function setActiveFeeBps(uint16 feeBps) external onlyAdmin {
        require(feeBps <= MAX_FEE_BPS, "FEE_CAP");
        activeFeeBps = feeBps;
    }

    function fundLiquidationOrder(
        LiquidationFundingOrder calldata order,
        bytes calldata signature,
        uint256 maxFunding
    ) external nonReentrant returns (uint256 fundedUsdc) {
        require(msg.sender == router, "UNAUTHORIZED");
        _validateOrderShape(order);
        require(maxFunding != 0, "INVALID_FUNDING");
        require(maxFunding <= order.maxRepayAssets - filled[_orderHash(order)], "OVERFILL");
        if (order.fillMode == 0) {
            require(maxFunding == order.maxRepayAssets, "FILL_OR_KILL");
        }
        bytes32 orderHash = _orderHash(order);
        require(pendingFunding[orderHash] == 0, "PENDING_FUNDING");
        require(!cancelled[order.maker][orderHash], "CANCELLED");
        bytes32 pairKey = keccak256(abi.encode(order.maker, order.debtAsset, order.collateralAsset));
        require(order.salt >= cancelledSalt[pairKey], "SALT_CANCELLED");
        require(_isValidSigner(order, orderHash, signature), "UNAUTHORIZED");

        pendingFunding[orderHash] = maxFunding;
        require(IERC20(usdc).transferFrom(order.maker, msg.sender, maxFunding), "TRANSFER_FAILED");
        return maxFunding;
    }

    function finalizeLiquidationOrder(
        LiquidationFundingOrder calldata order,
        address recipient,
        uint256 actualRepayment,
        uint256 deliveredCollateral,
        uint256 fee
    ) external nonReentrant {
        require(msg.sender == router, "UNAUTHORIZED");
        require(recipient != address(0), "INVALID_RECIPIENT");
        _validateOrderShape(order);
        bytes32 orderHash = _orderHash(order);
        uint256 funded = pendingFunding[orderHash];
        require(funded != 0, "NO_PENDING_FUNDING");
        require(actualRepayment != 0 && actualRepayment <= funded, "INVALID_REPAYMENT");
        if (order.fillMode == 0) {
            require(actualRepayment == funded, "FILL_OR_KILL");
        }
        require(fee <= deliveredCollateral, "INVALID_FEE");
        require(actualRepayment <= order.maxRepayAssets - filled[orderHash], "OVERFILL");

        pendingFunding[orderHash] = 0;
        filled[orderHash] += actualRepayment;
        emit Fill(
            orderHash,
            order.maker,
            recipient,
            order.debtAsset,
            order.collateralAsset,
            actualRepayment,
            deliveredCollateral,
            fee
        );
    }

    function _validateOrderShape(LiquidationFundingOrder calldata order) internal view {
        require(order.maker != address(0), "INVALID_MAKER");
        require(order.debtAsset == usdc, "DEBT_ASSET_MISMATCH");
        require(order.collateralAsset != address(0), "INVALID_COLLATERAL_ASSET");
        require(order.debtAsset != order.collateralAsset, "SAME_ASSET");
        require(order.maxRepayAssets != 0, "INVALID_MAX_REPAY");
        require(order.fillMode <= 1, "INVALID_FILL_MODE");
        require(block.timestamp <= order.expiry, "EXPIRED");
        require(order.feeLimitBps >= activeFeeBps, "FEE_LIMIT");
    }

    function registerOrderSigner(address signer) external {
        require(signer != address(0), "INVALID_SIGNER");
        orderSigners[msg.sender][signer] = true;
        emit SignerUpdated(msg.sender, signer, true);
    }

    function revokeOrderSigner(address signer) external {
        orderSigners[msg.sender][signer] = false;
        emit SignerUpdated(msg.sender, signer, false);
    }

    function cancelOrder(bytes32 orderHash) external {
        cancelled[msg.sender][orderHash] = true;
        emit Cancel(msg.sender, orderHash);
    }

    function cancelPairBelowSalt(address debtAsset, address collateralAsset, uint256 minSalt)
        external
    {
        bytes32 pairKey = keccak256(abi.encode(msg.sender, debtAsset, collateralAsset));
        if (minSalt > cancelledSalt[pairKey]) {
            cancelledSalt[pairKey] = minSalt;
        }
    }

    /// @notice Atomically settle a maker's signed B20 -> native USDC order.
    /// Stock moves from the bound taker to the maker; USDC moves from the
    /// maker to the router, which owns the final fee/min-out accounting.
    function fillSwapOrder(
        SwapOrder calldata order,
        bytes calldata signature,
        address taker,
        uint256 stockAmount
    ) external nonReentrant returns (uint256 usdcAmount) {
        require(msg.sender == router, "UNAUTHORIZED");
        require(taker != address(0) && stockAmount != 0, "INVALID_AMOUNT");
        require(order.maker != address(0) && order.signer != address(0), "INVALID_MAKER");
        require(order.stockToken != address(0) && order.stockToken != usdc, "ASSET_MISMATCH");
        require(order.usdcToken == usdc, "ASSET_MISMATCH");
        require(order.stockAmount != 0 && order.usdcAmount != 0, "INVALID_ORDER");
        require(order.fillMode <= 1, "INVALID_FILL_MODE");
        require(block.timestamp <= order.expiry, "EXPIRED");
        require(order.feeCapBps >= activeFeeBps, "FEE_LIMIT");
        require(order.allowedTaker == address(0) || order.allowedTaker == taker, "TAKER_MISMATCH");
        require(stockAmount <= order.stockAmount, "OVERFILL");
        bytes32 orderHash = _swapOrderHash(order);
        uint256 prior = swapFilled[orderHash];
        require(stockAmount <= order.stockAmount - prior, "OVERFILL");
        if (order.fillMode == 0) require(prior == 0 && stockAmount == order.stockAmount, "FILL_OR_KILL");
        require(!cancelled[order.maker][orderHash], "CANCELLED");
        bytes32 pairKey = keccak256(abi.encode(order.maker, order.stockToken, order.usdcToken));
        require(order.salt >= cancelledSalt[pairKey], "SALT_CANCELLED");
        require(_isValidSwapSigner(order, orderHash, signature), "UNAUTHORIZED");

        usdcAmount = stockAmount * order.usdcAmount / order.stockAmount;
        require(usdcAmount != 0, "ZERO_OUTPUT");
        swapFilled[orderHash] = prior + stockAmount;
        require(IERC20(order.stockToken).transferFrom(taker, order.maker, stockAmount), "STOCK_TRANSFER_FAILED");
        require(IERC20(usdc).transferFrom(order.maker, msg.sender, usdcAmount), "USDC_TRANSFER_FAILED");
        emit SwapFilled(orderHash, order.maker, taker, order.stockToken, order.usdcToken, stockAmount, usdcAmount);
    }

    function cancelSwapOrder(bytes32 orderHash) external {
        cancelled[msg.sender][orderHash] = true;
        emit Cancel(msg.sender, orderHash);
    }

    function cancelSwapPairBelowSalt(address stockToken, address usdcToken, uint256 minSalt)
        external
    {
        bytes32 pairKey = keccak256(abi.encode(msg.sender, stockToken, usdcToken));
        if (minSalt > cancelledSalt[pairKey]) cancelledSalt[pairKey] = minSalt;
    }

    function _orderHash(LiquidationFundingOrder calldata order) internal view returns (bytes32) {
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
        return BaseEIP712.hashLiquidationFundingOrder(typedOrder, block.chainid, address(this));
    }

    function _swapOrderHash(SwapOrder calldata order) internal view returns (bytes32) {
        BaseEIP712.SwapOrder memory typedOrder = BaseEIP712.SwapOrder({
            maker: order.maker,
            signer: order.signer,
            stockToken: order.stockToken,
            usdcToken: order.usdcToken,
            stockAmount: order.stockAmount,
            usdcAmount: order.usdcAmount,
            fillMode: order.fillMode,
            expiry: order.expiry,
            salt: order.salt,
            feeCapBps: order.feeCapBps,
            allowedTaker: order.allowedTaker,
            rfqId: order.rfqId
        });
        return BaseEIP712.hashSwapOrder(typedOrder, block.chainid, address(this));
    }

    function _isValidSigner(
        LiquidationFundingOrder calldata order,
        bytes32 orderHash,
        bytes calldata signature
    ) internal view returns (bool) {
        require(
            order.signer == order.maker || orderSigners[order.maker][order.signer], "UNAUTHORIZED"
        );
        if (order.signer.code.length != 0) {
            return
                IERC1271(order.signer).isValidSignature(orderHash, signature) == ERC1271_MAGICVALUE;
        }
        if (signature.length != 65) {
            return false;
        }
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) {
            v += 27;
        }
        return v == 27 || v == 28 ? ecrecover(orderHash, v, r, s) == order.signer : false;
    }

    function _isValidSwapSigner(
        SwapOrder calldata order,
        bytes32 orderHash,
        bytes calldata signature
    ) internal view returns (bool) {
        require(order.signer == order.maker || orderSigners[order.maker][order.signer], "UNAUTHORIZED");
        if (order.signer.code.length != 0) {
            return IERC1271(order.signer).isValidSignature(orderHash, signature) == ERC1271_MAGICVALUE;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        return (v == 27 || v == 28) && ecrecover(orderHash, v, r, s) == order.signer;
    }
}
