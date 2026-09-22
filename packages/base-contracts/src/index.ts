export const BASE_B20_ABI_COMMIT = 'be6d0450890e20fc4a739aeaff5e839f234d12a6' as const;

export const baseContractAddresses = {
  84532: {},
  8453: {},
} as const;

export const RFQ_ROUTER_EVENTS_ABI = [
  {
    type: 'event', name: 'RouteFilled',
    inputs: [
      { indexed: true, name: 'rfqId', type: 'bytes32' },
      { indexed: true, name: 'winner', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'adapter', type: 'address' },
      { indexed: false, name: 'repayAssets', type: 'uint256' },
      { indexed: false, name: 'collateralSeized', type: 'uint256' },
      { indexed: false, name: 'fee', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'AdapterAllowlisted',
    inputs: [
      { indexed: true, name: 'adapter', type: 'address' },
      { indexed: false, name: 'allowed', type: 'bool' },
    ],
  },
  {
    type: 'event', name: 'FacilityAllowlisted',
    inputs: [
      { indexed: true, name: 'facility', type: 'address' },
      { indexed: false, name: 'allowed', type: 'bool' },
    ],
  },
  {
    type: 'event', name: 'FeeUpdated',
    inputs: [{ indexed: false, name: 'feeBps', type: 'uint16' }],
  },
  {
    type: 'event', name: 'OracleGuardUpdated',
    inputs: [{ indexed: true, name: 'guard', type: 'address' }],
  },
  {
    type: 'event', name: 'B20GuardUpdated',
    inputs: [{ indexed: true, name: 'guard', type: 'address' }],
  },
  {
    type: 'event', name: 'SwapRouteFilled',
    inputs: [
      { indexed: true, name: 'requestId', type: 'bytes32' },
      { indexed: true, name: 'taker', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'stockToken', type: 'address' },
      { indexed: false, name: 'usdcToken', type: 'address' },
      { indexed: false, name: 'stockAmount', type: 'uint256' },
      { indexed: false, name: 'boughtUsdc', type: 'uint256' },
      { indexed: false, name: 'fee', type: 'uint256' },
    ],
  },
] as const;

export const RFQ_SETTLEMENT_EVENTS_ABI = [
  {
    type: 'event', name: 'Fill',
    inputs: [
      { indexed: true, name: 'orderHash', type: 'bytes32' },
      { indexed: true, name: 'maker', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'debtAsset', type: 'address' },
      { indexed: false, name: 'collateralAsset', type: 'address' },
      { indexed: false, name: 'repayAssets', type: 'uint256' },
      { indexed: false, name: 'collateralOut', type: 'uint256' },
      { indexed: false, name: 'fee', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'Cancel',
    inputs: [
      { indexed: true, name: 'maker', type: 'address' },
      { indexed: true, name: 'orderHash', type: 'bytes32' },
    ],
  },
  {
    type: 'event', name: 'SignerUpdated',
    inputs: [
      { indexed: true, name: 'maker', type: 'address' },
      { indexed: true, name: 'signer', type: 'address' },
      { indexed: false, name: 'authorized', type: 'bool' },
    ],
  },
  {
    type: 'event', name: 'SwapFilled',
    inputs: [
      { indexed: true, name: 'orderHash', type: 'bytes32' },
      { indexed: true, name: 'maker', type: 'address' },
      { indexed: true, name: 'taker', type: 'address' },
      { indexed: false, name: 'stockToken', type: 'address' },
      { indexed: false, name: 'usdcToken', type: 'address' },
      { indexed: false, name: 'stockAmount', type: 'uint256' },
      { indexed: false, name: 'usdcAmount', type: 'uint256' },
    ],
  },
] as const;

export const FACILITY_AGGREGATOR_EVENTS_ABI = [
  {
    type: 'event', name: 'FacilityRegistered',
    inputs: [
      { indexed: true, name: 'curator', type: 'address' },
      { indexed: true, name: 'facility', type: 'address' },
    ],
  },
  {
    type: 'event', name: 'FacilityPaused',
    inputs: [{ indexed: true, name: 'facility', type: 'address' }],
  },
  {
    type: 'event', name: 'FacilityRevoked',
    inputs: [{ indexed: true, name: 'facility', type: 'address' }],
  },
] as const;

export const LIQUIDITY_FACILITY_EVENTS_ABI = [
  {
    type: 'event', name: 'Deposit',
    inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: false, name: 'assets', type: 'uint256' },
      { indexed: false, name: 'shares', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'Withdraw',
    inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'receiver', type: 'address' },
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: false, name: 'assets', type: 'uint256' },
      { indexed: false, name: 'shares', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'WithdrawQueued',
    inputs: [
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: true, name: 'requestId', type: 'uint256' },
      { indexed: false, name: 'assets', type: 'uint256' },
      { indexed: false, name: 'shares', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'WithdrawClaimed',
    inputs: [
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: true, name: 'requestId', type: 'uint256' },
      { indexed: false, name: 'assets', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'VenueAllocation',
    inputs: [
      { indexed: true, name: 'adapter', type: 'address' },
      { indexed: false, name: 'assets', type: 'uint256' },
      { indexed: false, name: 'allocating', type: 'bool' },
    ],
  },
  {
    type: 'event', name: 'InventoryAcquired',
    inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'usdcPaid', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'StockPriceUpdated',
    inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: false, name: 'priceWad', type: 'uint256' },
      { indexed: false, name: 'updatedAt', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'StockMultiplierUpdated',
    inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: false, name: 'multiplierWad', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'RedemptionLotBooked',
    inputs: [
      { indexed: true, name: 'lotId', type: 'uint256' },
      { indexed: true, name: 'token', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'acquisitionCost', type: 'uint256' },
      { indexed: false, name: 'operator', type: 'address' },
    ],
  },
  {
    type: 'event', name: 'RedemptionSettled',
    inputs: [
      { indexed: true, name: 'lotId', type: 'uint256' },
      { indexed: false, name: 'usdcProceeds', type: 'uint256' },
      { indexed: false, name: 'realizedPnl', type: 'int256' },
    ],
  },
] as const;

/** Events copied from the official IB20/IB20Asset/IERC8056 interfaces at BASE_B20_ABI_COMMIT. */
export const B20_EVENTS_ABI = [
  {
    type: 'event', name: 'Paused',
    inputs: [
      { indexed: true, name: 'updater', type: 'address' },
      { indexed: false, name: 'features', type: 'uint8[]' },
    ],
  },
  {
    type: 'event', name: 'Unpaused',
    inputs: [
      { indexed: true, name: 'updater', type: 'address' },
      { indexed: false, name: 'features', type: 'uint8[]' },
    ],
  },
  {
    type: 'event', name: 'Announcement',
    inputs: [
      { indexed: true, name: 'caller', type: 'address' },
      { indexed: false, name: 'id', type: 'string' },
      { indexed: false, name: 'description', type: 'string' },
      { indexed: false, name: 'uri', type: 'string' },
    ],
  },
  {
    type: 'event', name: 'EndAnnouncement',
    inputs: [{ indexed: false, name: 'id', type: 'string' }],
  },
  {
    type: 'event', name: 'MultiplierUpdated',
    inputs: [{ indexed: false, name: 'multiplier', type: 'uint256' }],
  },
  {
    type: 'event', name: 'UIMultiplierUpdateCancelled',
    inputs: [
      { indexed: false, name: 'cancelledMultiplier', type: 'uint256' },
      { indexed: false, name: 'cancelledEffectiveAt', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'UIMultiplierUpdated',
    inputs: [
      { indexed: false, name: 'oldMultiplier', type: 'uint256' },
      { indexed: false, name: 'newMultiplier', type: 'uint256' },
      { indexed: false, name: 'effectiveAtTimestamp', type: 'uint256' },
    ],
  },
] as const;

export const BASE_ROUTER_EVENTS_ABI = RFQ_ROUTER_EVENTS_ABI;
export const BASE_SETTLEMENT_EVENTS_ABI = RFQ_SETTLEMENT_EVENTS_ABI;
export const BASE_FACILITY_AGGREGATOR_EVENTS_ABI = FACILITY_AGGREGATOR_EVENTS_ABI;
export const BASE_LIQUIDITY_FACILITY_EVENTS_ABI = LIQUIDITY_FACILITY_EVENTS_ABI;
export const BASE_B20_EVENTS_ABI = B20_EVENTS_ABI;

export const BASE_INDEXER_EVENT_ABI = [
  ...RFQ_ROUTER_EVENTS_ABI,
  ...RFQ_SETTLEMENT_EVENTS_ABI,
  ...FACILITY_AGGREGATOR_EVENTS_ABI,
  ...LIQUIDITY_FACILITY_EVENTS_ABI,
  ...B20_EVENTS_ABI,
] as const;

export const RFQ_ROUTER_EXECUTE_ABI = [{
  type: 'function',
  name: 'executeLiquidationRoute',
  stateMutability: 'nonpayable',
  inputs: [{
    name: 'plan',
    type: 'tuple',
    components: [
      { name: 'rfqId', type: 'bytes32' },
      { name: 'winner', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'borrower', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'source', type: 'uint8' },
      { name: 'settlementOrFacility', type: 'address' },
      { name: 'liquidationAdapter', type: 'address' },
      { name: 'repayAssets', type: 'uint256' },
      { name: 'minCollateralOutRfq', type: 'uint256' },
      { name: 'minCollateralOutFunder', type: 'uint256' },
      { name: 'decisionBlock', type: 'uint256' },
      { name: 'decisionBlockHash', type: 'bytes32' },
      { name: 'fundingPayload', type: 'bytes' },
    ],
  }],
  outputs: [
    { name: 'repaidAssets', type: 'uint256' },
    { name: 'collateralSeized', type: 'uint256' },
    { name: 'fee', type: 'uint256' },
  ],
}] as const;

/** Native B20 -> USDC route execution. LP and facility legs are blended only
 * inside this Katon call; venue-native alternatives use their own packet. */
export const RFQ_ROUTER_SWAP_EXECUTE_ABI = [{
  type: 'function',
  name: 'executeSwapRoute',
  stateMutability: 'nonpayable',
  inputs: [
    {
      name: 'plan',
      type: 'tuple',
      components: [
        { name: 'requestId', type: 'bytes32' },
        { name: 'taker', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'stockToken', type: 'address' },
        { name: 'usdcToken', type: 'address' },
        { name: 'settlement', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'minBuyAmount', type: 'uint256' },
        { name: 'feeCapBps', type: 'uint16' },
        { name: 'deadline', type: 'uint256' },
        { name: 'decisionBlock', type: 'uint256' },
        { name: 'decisionBlockHash', type: 'bytes32' },
      ],
    },
    {
      name: 'legs',
      type: 'tuple[]',
      components: [
        { name: 'source', type: 'uint8' },
        { name: 'liquidity', type: 'address' },
        { name: 'stockAmount', type: 'uint256' },
        { name: 'minUsdcOut', type: 'uint256' },
        { name: 'payload', type: 'bytes' },
      ],
    },
  ],
  outputs: [
    { name: 'boughtUsdc', type: 'uint256' },
    { name: 'fee', type: 'uint256' },
  ],
}] as const;

/** Browser-safe ERC-20 interface. All amount arguments are uint256/bigint. */
export const ERC20_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

/** Read/write interface for the deployed liquidity facility. */
export const LIQUIDITY_FACILITY_ABI = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'curator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'executor', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'router', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'quote', stateMutability: 'view', inputs: [{ name: 'stockToken', type: 'address' }, { name: 'stockAmount', type: 'uint256' }], outputs: [{ name: 'usdcAmount', type: 'uint256' }, { name: 'capacity', type: 'uint256' }, { name: 'expiry', type: 'uint256' }] },
  { type: 'function', name: 'buyStock', stateMutability: 'nonpayable', inputs: [{ name: 'stockToken', type: 'address' }, { name: 'stockAmount', type: 'uint256' }, { name: 'usdcAmount', type: 'uint256' }], outputs: [{ name: 'paidUsdc', type: 'uint256' }] },
  { type: 'function', name: 'stockPriceWad', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'stockMultiplierWad', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'stockExposure', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'stockExposureCap', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'redemptionOperator', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'setStockPrice', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'priceWad_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setStockMultiplier', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'multiplierWad_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setStockExposureCap', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'cap', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setRedemptionPath', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'enabled', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'bookRedemption', stateMutability: 'nonpayable', inputs: [{ name: 'inventoryLotId', type: 'uint256' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: 'redemptionLotId', type: 'uint256' }] },
  { type: 'function', name: 'settleRedemption', stateMutability: 'nonpayable', inputs: [{ name: 'redemptionLotId', type: 'uint256' }, { name: 'usdcProceeds', type: 'uint256' }], outputs: [{ name: 'realizedPnl', type: 'int256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'quotePaused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'haircutWad', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'idleAssets', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'convertToShares', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'previewWithdraw', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'quoteUsdcCapacity', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'nextRequestId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'queueHead', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'reservedQueueAssets', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'withdrawRequests', stateMutability: 'view', inputs: [{ name: 'requestId', type: 'uint256' }], outputs: [{ name: 'owner', type: 'address' }, { name: 'assets', type: 'uint256' }, { name: 'shares', type: 'uint256' }] },
  { type: 'function', name: 'adapterAllowed', stateMutability: 'view', inputs: [{ name: 'adapter', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'adapterRegistered', stateMutability: 'view', inputs: [{ name: 'adapter', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'adapters', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'inventoryAtAcquisitionCost', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'inventoryLots', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'usdcPaid', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'owner', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
  { type: 'function', name: 'requestWithdraw', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: 'requestId', type: 'uint256' }] },
  { type: 'function', name: 'claimWithdraw', stateMutability: 'nonpayable', inputs: [{ name: 'requestId', type: 'uint256' }], outputs: [{ name: 'assets', type: 'uint256' }] },
  { type: 'function', name: 'setAdapterAllowed', stateMutability: 'nonpayable', inputs: [{ name: 'adapter', type: 'address' }, { name: 'allowed', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'allocate', stateMutability: 'nonpayable', inputs: [{ name: 'adapter', type: 'address' }, { name: 'assets', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'deallocate', stateMutability: 'nonpayable', inputs: [{ name: 'adapter', type: 'address' }, { name: 'assets', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setHaircutWad', stateMutability: 'nonpayable', inputs: [{ name: 'haircutWad_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setQuotePaused', stateMutability: 'nonpayable', inputs: [{ name: 'paused_', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const;

/** Public OracleGuard reads plus curator/admin configuration writes. */
export const ORACLE_GUARD_ABI = [
  { type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'sequencerFeed', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'oracleRegistry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'gracePeriod', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'feedConfigs', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: 'feed', type: 'address' }, { name: 'heartbeat', type: 'uint256' }] },
  { type: 'function', name: 'snapshot', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: 'answer', type: 'int256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'decimals', type: 'uint8' }, { name: 'sequencerUp', type: 'bool' }, { name: 'sequencerStartedAt', type: 'uint256' }, { name: 'registryPaused', type: 'bool' }] },
  { type: 'function', name: 'requireFresh', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
  { type: 'function', name: 'configureFeed', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'feed', type: 'address' }, { name: 'heartbeat', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setGracePeriod', stateMutability: 'nonpayable', inputs: [{ name: 'gracePeriod_', type: 'uint256' }], outputs: [] },
] as const;

/** Public B20Guard checks and multiplier reads. */
export const B20_GUARD_ABI = [
  { type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'policyRegistry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'requireTransferAndSeizeLive', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [] },
  { type: 'function', name: 'requireTransferAuthorized', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'sender', type: 'address' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'multiplierWad', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'scaledBalanceOf', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

// Explicit aliases make the browser package contract boundary self-documenting.
export const ERC20_CLIENT_ABI = ERC20_ABI;
export const LIQUIDITY_FACILITY_CLIENT_ABI = LIQUIDITY_FACILITY_ABI;
export const ORACLE_GUARD_CLIENT_ABI = ORACLE_GUARD_ABI;
export const B20_GUARD_CLIENT_ABI = B20_GUARD_ABI;

export const BASE_CONTRACT_ABIS = {
  erc20: ERC20_ABI,
  liquidityFacility: LIQUIDITY_FACILITY_ABI,
  oracleGuard: ORACLE_GUARD_ABI,
  b20Guard: B20_GUARD_ABI,
  routerEvents: RFQ_ROUTER_EVENTS_ABI,
  router: RFQ_ROUTER_EXECUTE_ABI,
  routerSwap: RFQ_ROUTER_SWAP_EXECUTE_ABI,
  settlementEvents: RFQ_SETTLEMENT_EVENTS_ABI,
  facilityAggregatorEvents: FACILITY_AGGREGATOR_EVENTS_ABI,
  facilityEvents: LIQUIDITY_FACILITY_EVENTS_ABI,
  b20Events: B20_EVENTS_ABI,
} as const;
