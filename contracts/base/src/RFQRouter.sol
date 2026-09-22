// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "./IERC20.sol";
import { IB20Guard } from "./IB20Guard.sol";
import { ILiquidationAdapter } from "./ILiquidationAdapter.sol";
import { ILiquidityFacility } from "./ILiquidityFacility.sol";
import { IOracleGuard } from "./IOracleGuard.sol";
import { IRFQRouter } from "./IRFQRouter.sol";
import { IRFQSettlement } from "./IRFQSettlement.sol";

interface IERC20Approval is IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);
}

contract RFQRouter is IRFQRouter {
    uint16 public constant MAX_FEE_BPS = 50;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    address public admin;
    address public feeRecipient;
    IOracleGuard public oracleGuard;
    IB20Guard public b20Guard;
    uint16 public feeBps;
    uint64 public maxDecisionBlockAge;

    mapping(address => bool) public liquidationAdapters;
    mapping(address => bool) public settlements;
    mapping(address => bool) public facilities;
    mapping(bytes32 => bool) public usedRfqIds;
    mapping(bytes32 => bool) public usedSwapRequestIds;
    uint256 private _status = 1;

    event RouteFilled(
        bytes32 indexed rfqId,
        address indexed winner,
        address indexed recipient,
        address adapter,
        uint256 repayAssets,
        uint256 collateralSeized,
        uint256 fee
    );
    event AdapterAllowlisted(address indexed adapter, bool allowed);
    event FacilityAllowlisted(address indexed facility, bool allowed);
    event FeeUpdated(uint16 feeBps);
    event OracleGuardUpdated(address indexed guard);
    event B20GuardUpdated(address indexed guard);
    event SwapRouteFilled(
        bytes32 indexed requestId,
        address indexed taker,
        address indexed recipient,
        address stockToken,
        address usdcToken,
        uint256 stockAmount,
        uint256 boughtUsdc,
        uint256 fee
    );

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

    constructor() {
        admin = msg.sender;
        feeRecipient = msg.sender;
    }

    function setLiquidationAdapter(address adapter, bool allowed) external onlyAdmin {
        require(adapter != address(0), "INVALID_ADAPTER");
        liquidationAdapters[adapter] = allowed;
        emit AdapterAllowlisted(adapter, allowed);
    }

    function setSettlement(address settlement, bool allowed) external onlyAdmin {
        require(settlement != address(0), "INVALID_SETTLEMENT");
        settlements[settlement] = allowed;
    }

    function setFacility(address facility, bool allowed) external onlyAdmin {
        require(facility != address(0), "INVALID_FACILITY");
        facilities[facility] = allowed;
        emit FacilityAllowlisted(facility, allowed);
    }

    function setFeeRecipient(address recipient) external onlyAdmin {
        require(recipient != address(0), "INVALID_FEE_RECIPIENT");
        feeRecipient = recipient;
    }

    function setFeeBps(uint16 feeBps_) external onlyAdmin {
        require(feeBps_ <= MAX_FEE_BPS, "FEE_CAP");
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function setMaxDecisionBlockAge(uint64 age) external onlyAdmin {
        maxDecisionBlockAge = age;
    }

    function setOracleGuard(address guard) external onlyAdmin {
        require(guard != address(0), "INVALID_ORACLE_GUARD");
        oracleGuard = IOracleGuard(guard);
        emit OracleGuardUpdated(guard);
    }

    function setB20Guard(address guard) external onlyAdmin {
        require(guard != address(0), "INVALID_B20_GUARD");
        b20Guard = IB20Guard(guard);
        emit B20GuardUpdated(guard);
    }

    function executeLiquidationRoute(LiquidationRoutePlan calldata plan)
        external
        nonReentrant
        returns (uint256 repaidAssets, uint256 collateralSeized, uint256 fee)
    {
        require(msg.sender == plan.winner, "UNAUTHORIZED");
        require(plan.winner != address(0) && plan.recipient != address(0), "INVALID_PARTICIPANT");
        require(block.timestamp <= plan.deadline, "EXPIRED");
        require(plan.decisionBlock <= block.number, "STALE_DECISION");
        require(block.number - plan.decisionBlock <= maxDecisionBlockAge, "STALE_DECISION");
        if (plan.decisionBlockHash != bytes32(0)) {
            require(blockhash(plan.decisionBlock) == plan.decisionBlockHash, "STALE_DECISION");
        }
        require(!usedRfqIds[plan.rfqId], "RFQ_USED");
        require(liquidationAdapters[plan.liquidationAdapter], "ADAPTER_NOT_ALLOWED");
        address debtAsset;
        address collateralAsset;
        bytes32 marketId;
        uint256 routeMinCollateral;
        IRFQSettlement.LiquidationFundingOrder memory lpOrder;
        bytes memory lpSignature;

        if (plan.source == FundingSource.LP) {
            require(settlements[plan.settlementOrFacility], "SETTLEMENT_NOT_ALLOWED");
            (lpOrder, lpSignature) =
                abi.decode(plan.fundingPayload, (IRFQSettlement.LiquidationFundingOrder, bytes));
            require(
                keccak256(abi.encode(lpOrder, lpSignature)) == keccak256(plan.fundingPayload),
                "INVALID_PAYLOAD"
            );
            require(lpOrder.maker == plan.winner, "UNAUTHORIZED");
            require(lpOrder.rfqId == bytes32(0) || lpOrder.rfqId == plan.rfqId, "RFQ_MISMATCH");
            require(lpOrder.venue == address(0) || lpOrder.venue == plan.liquidationAdapter, "VENUE_MISMATCH");
            require(lpOrder.collateralAsset != address(0), "INVALID_COLLATERAL_ASSET");
            debtAsset = lpOrder.debtAsset;
            collateralAsset = lpOrder.collateralAsset;
            marketId = lpOrder.marketId;
            routeMinCollateral = _max(
                lpOrder.minCollateralOut, _max(plan.minCollateralOutRfq, plan.minCollateralOutFunder)
            );
        } else {
            address facility = plan.settlementOrFacility;
            require(facilities[facility], "FACILITY_NOT_ALLOWED");
            require(plan.winner == ILiquidityFacility(facility).executor(), "UNAUTHORIZED");
            require(plan.recipient == facility, "INVALID_FACILITY_RECIPIENT");
            bytes32 quoteId;
            (quoteId, marketId, debtAsset, collateralAsset) =
                abi.decode(plan.fundingPayload, (bytes32, bytes32, address, address));
            require(
                keccak256(abi.encode(quoteId, marketId, debtAsset, collateralAsset))
                    == keccak256(plan.fundingPayload),
                "INVALID_PAYLOAD"
            );
            require(collateralAsset != address(0), "INVALID_COLLATERAL_ASSET");
            require(debtAsset == ILiquidityFacility(facility).asset(), "ASSET_MISMATCH");
            require(debtAsset != collateralAsset, "SAME_ASSET");
            routeMinCollateral = _max(plan.minCollateralOutRfq, plan.minCollateralOutFunder);
        }

        require(debtAsset != collateralAsset, "SAME_ASSET");

        require(
            address(oracleGuard) != address(0) && address(oracleGuard).code.length != 0,
            "ORACLE_GUARD_UNSET"
        );
        require(
            address(b20Guard) != address(0) && address(b20Guard).code.length != 0, "B20_GUARD_UNSET"
        );
        oracleGuard.requireFresh(collateralAsset);
        b20Guard.requireTransferAndSeizeLive(collateralAsset);
        b20Guard.requireTransferAuthorized(collateralAsset, plan.liquidationAdapter, address(this));
        b20Guard.requireTransferAuthorized(collateralAsset, address(this), plan.recipient);
        if (feeBps != 0) {
            b20Guard.requireTransferAuthorized(collateralAsset, address(this), feeRecipient);
        }

        usedRfqIds[plan.rfqId] = true;

        uint256 debtBalanceBeforeRoute = IERC20(debtAsset).balanceOf(address(this));
        uint256 collateralBalanceBeforeRoute = IERC20(collateralAsset).balanceOf(address(this));
        uint256 fundedUsdc;

        if (plan.source == FundingSource.LP) {
            fundedUsdc = IRFQSettlement(plan.settlementOrFacility)
                .fundLiquidationOrder(lpOrder, lpSignature, plan.repayAssets);
        } else {
            fundedUsdc = ILiquidityFacility(plan.settlementOrFacility)
                .fundLiquidation(plan.repayAssets, address(this));
        }

        require(fundedUsdc != 0, "ZERO_EXECUTION");
        require(IERC20Approval(debtAsset).approve(plan.liquidationAdapter, 0), "APPROVAL_FAILED");
        require(
            IERC20Approval(debtAsset).approve(plan.liquidationAdapter, fundedUsdc),
            "APPROVAL_FAILED"
        );
        uint256 debtBalanceBeforeAdapter = IERC20(debtAsset).balanceOf(address(this));
        uint256 collateralBalanceBeforeAdapter = IERC20(collateralAsset).balanceOf(address(this));
        (uint256 reportedRepaid, uint256 reportedCollateral) = ILiquidationAdapter(
            plan.liquidationAdapter
        ).liquidate(
            ILiquidationAdapter.Request({
                marketId: marketId,
                borrower: plan.borrower,
                debtAsset: debtAsset,
                collateralAsset: collateralAsset,
                maxRepayAssets: fundedUsdc,
                minCollateralOut: routeMinCollateral,
                recipient: address(this)
            })
        );
        require(IERC20Approval(debtAsset).approve(plan.liquidationAdapter, 0), "APPROVAL_FAILED");

        uint256 debtBalanceAfterAdapter = IERC20(debtAsset).balanceOf(address(this));
        uint256 collateralBalanceAfterAdapter = IERC20(collateralAsset).balanceOf(address(this));
        require(debtBalanceAfterAdapter <= debtBalanceBeforeAdapter, "DEBT_BALANCE_INCREASE");
        require(
            collateralBalanceAfterAdapter >= collateralBalanceBeforeAdapter,
            "COLLATERAL_BALANCE_DECREASE"
        );
        repaidAssets = debtBalanceBeforeAdapter - debtBalanceAfterAdapter;
        collateralSeized = collateralBalanceAfterAdapter - collateralBalanceBeforeAdapter;
        require(repaidAssets != 0 && collateralSeized != 0, "ZERO_EXECUTION");
        require(repaidAssets <= fundedUsdc, "REPAYMENT_EXCEEDS_FUNDING");
        require(reportedRepaid == repaidAssets, "ADAPTER_ACCOUNTING_MISMATCH");
        require(reportedCollateral == collateralSeized, "ADAPTER_ACCOUNTING_MISMATCH");
        if (plan.source == FundingSource.LP && lpOrder.fillMode == 0) {
            require(repaidAssets == fundedUsdc, "FILL_OR_KILL");
        }

        fee = collateralSeized * feeBps / BPS_DENOMINATOR;
        uint256 netCollateral = collateralSeized - fee;
        require(netCollateral >= plan.minCollateralOutRfq, "MIN_OUT");
        require(netCollateral >= plan.minCollateralOutFunder, "MIN_OUT");
        require(netCollateral >= routeMinCollateral, "MIN_OUT");
        if (fee != 0) {
            require(IERC20(collateralAsset).transfer(feeRecipient, fee), "FEE_TRANSFER_FAILED");
        }
        require(
            IERC20(collateralAsset).transfer(plan.recipient, netCollateral),
            "COLLATERAL_TRANSFER_FAILED"
        );
        uint256 unusedFunding = fundedUsdc - repaidAssets;
        if (plan.source == FundingSource.LP) {
            if (unusedFunding != 0) {
                require(
                    IERC20(debtAsset).transfer(lpOrder.maker, unusedFunding),
                    "FUNDING_REFUND_FAILED"
                );
            }
            IRFQSettlement(plan.settlementOrFacility).finalizeLiquidationOrder(
                lpOrder, plan.recipient, repaidAssets, netCollateral, fee
            );
        } else {
            if (unusedFunding != 0) {
                require(
                    IERC20Approval(debtAsset).approve(plan.settlementOrFacility, unusedFunding),
                    "APPROVAL_FAILED"
                );
            }
            ILiquidityFacility(plan.settlementOrFacility)
                .acquireInventory(collateralAsset, netCollateral, repaidAssets);
            if (unusedFunding != 0) {
                require(
                    IERC20Approval(debtAsset).approve(plan.settlementOrFacility, 0),
                    "APPROVAL_FAILED"
                );
            }
        }
        require(
            IERC20Approval(debtAsset).allowance(address(this), plan.liquidationAdapter) == 0,
            "ALLOWANCE_NOT_CLEARED"
        );
        require(
            IERC20(debtAsset).balanceOf(address(this)) == debtBalanceBeforeRoute,
            "ROUTER_DEBT_DUST"
        );
        require(
            IERC20(collateralAsset).balanceOf(address(this)) == collateralBalanceBeforeRoute,
            "ROUTER_COLLATERAL_DUST"
        );
        emit RouteFilled(
            plan.rfqId,
            plan.winner,
            plan.recipient,
            plan.liquidationAdapter,
            repaidAssets,
            collateralSeized,
            fee
        );
    }

    /// @notice Execute a taker-submitted, atomically blended B20 sale.
    /// LP legs consume signed v2 orders through RFQSettlement; facility legs
    /// transfer stock into an allowlisted redemption-capable facility. Every
    /// leg and the final net output is checked before any token leaves router.
    function executeSwapRoute(SwapRoutePlan calldata plan, SwapRouteLeg[] calldata legs)
        external
        nonReentrant
        returns (uint256 boughtUsdc, uint256 fee)
    {
        require(msg.sender == plan.taker, "UNAUTHORIZED");
        require(plan.taker != address(0) && plan.recipient != address(0), "INVALID_PARTICIPANT");
        require(plan.stockToken != address(0) && plan.usdcToken != address(0), "INVALID_ASSET");
        require(plan.stockToken != plan.usdcToken, "SAME_ASSET");
        require(plan.settlement != address(0) && settlements[plan.settlement], "SETTLEMENT_NOT_ALLOWED");
        require(IRFQSettlement(plan.settlement).usdc() == plan.usdcToken, "SETTLEMENT_ASSET_MISMATCH");
        require(plan.sellAmount != 0 && plan.minBuyAmount != 0 && legs.length != 0, "INVALID_AMOUNT");
        require(block.timestamp <= plan.deadline, "EXPIRED");
        require(plan.feeCapBps <= MAX_FEE_BPS && feeBps <= plan.feeCapBps, "FEE_CAP");
        require(plan.decisionBlock <= block.number, "STALE_DECISION");
        require(block.number - plan.decisionBlock <= maxDecisionBlockAge, "STALE_DECISION");
        if (plan.decisionBlockHash != bytes32(0)) require(blockhash(plan.decisionBlock) == plan.decisionBlockHash, "STALE_DECISION");
        require(!usedSwapRequestIds[plan.requestId], "REQUEST_USED");
        require(address(oracleGuard) != address(0) && address(oracleGuard).code.length != 0, "ORACLE_GUARD_UNSET");
        require(address(b20Guard) != address(0) && address(b20Guard).code.length != 0, "B20_GUARD_UNSET");
        oracleGuard.requireFresh(plan.stockToken);
        b20Guard.requireTransferAndSeizeLive(plan.stockToken);

        uint256 totalStock;
        uint256 usdcBalanceBefore = IERC20(plan.usdcToken).balanceOf(address(this));
        usedSwapRequestIds[plan.requestId] = true;
        for (uint256 i = 0; i < legs.length; i++) {
            SwapRouteLeg calldata leg = legs[i];
            require(leg.liquidity != address(0) && leg.stockAmount != 0, "INVALID_LEG");
            totalStock += leg.stockAmount;
            uint256 legOutput;
            if (leg.source == SwapLiquiditySource.LP) {
                (IRFQSettlement.SwapOrder memory order, bytes memory signature) =
                    abi.decode(leg.payload, (IRFQSettlement.SwapOrder, bytes));
                require(
                    keccak256(abi.encode(order, signature)) == keccak256(leg.payload),
                    "INVALID_PAYLOAD"
                );
                require(order.maker == leg.liquidity, "MAKER_MISMATCH");
                require(order.stockToken == plan.stockToken && order.usdcToken == plan.usdcToken, "ASSET_MISMATCH");
                require(order.rfqId == bytes32(0) || order.rfqId == plan.requestId, "RFQ_MISMATCH");
                require(order.allowedTaker == address(0) || order.allowedTaker == plan.taker, "TAKER_MISMATCH");
                require(order.feeCapBps >= feeBps, "FEE_LIMIT");
                b20Guard.requireTransferAuthorized(plan.stockToken, plan.taker, order.maker);
                legOutput = IRFQSettlement(plan.settlement).fillSwapOrder(order, signature, plan.taker, leg.stockAmount);
            } else {
                require(facilities[leg.liquidity], "FACILITY_NOT_ALLOWED");
                require(ILiquidityFacility(leg.liquidity).router() == address(this), "FACILITY_ROUTER_MISMATCH");
                require(ILiquidityFacility(leg.liquidity).asset() == plan.usdcToken, "ASSET_MISMATCH");
                (bytes32 quoteId, uint256 expectedUsdc, uint256 expectedStock, uint256 expiry) =
                    abi.decode(leg.payload, (bytes32, uint256, uint256, uint256));
                require(
                    keccak256(abi.encode(quoteId, expectedUsdc, expectedStock, expiry))
                        == keccak256(leg.payload),
                    "INVALID_PAYLOAD"
                );
                quoteId; // The signed quote id is retained for event/indexer correlation.
                require(expectedStock == leg.stockAmount && expectedUsdc != 0, "INVALID_QUOTE");
                require(expiry >= block.timestamp, "EXPIRED");
                b20Guard.requireTransferAuthorized(plan.stockToken, plan.taker, leg.liquidity);
                require(IERC20(plan.stockToken).transferFrom(plan.taker, leg.liquidity, leg.stockAmount), "STOCK_TRANSFER_FAILED");
                legOutput = ILiquidityFacility(leg.liquidity).buyStock(plan.stockToken, leg.stockAmount, expectedUsdc);
            }
            require(legOutput >= leg.minUsdcOut, "LEG_MIN_OUT");
            boughtUsdc += legOutput;
        }
        require(totalStock == plan.sellAmount, "STOCK_TOTAL");
        require(boughtUsdc >= plan.minBuyAmount, "MIN_OUT");
        uint256 observedUsdc = IERC20(plan.usdcToken).balanceOf(address(this)) - usdcBalanceBefore;
        require(observedUsdc >= boughtUsdc, "USDC_ACCOUNTING");
        fee = boughtUsdc * feeBps / BPS_DENOMINATOR;
        uint256 netUsdc = boughtUsdc - fee;
        require(netUsdc >= plan.minBuyAmount, "MIN_OUT");
        if (fee != 0) require(IERC20(plan.usdcToken).transfer(feeRecipient, fee), "FEE_TRANSFER_FAILED");
        require(IERC20(plan.usdcToken).transfer(plan.recipient, netUsdc), "USDC_TRANSFER_FAILED");
        require(IERC20(plan.usdcToken).balanceOf(address(this)) == usdcBalanceBefore + observedUsdc - boughtUsdc, "USDC_DUST");
        emit SwapRouteFilled(plan.requestId, plan.taker, plan.recipient, plan.stockToken, plan.usdcToken, totalStock, boughtUsdc, fee);
    }

    function _max(uint256 left, uint256 right) private pure returns (uint256) {
        return left > right ? left : right;
    }
}
