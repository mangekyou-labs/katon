import {
  type BaseChainEvent,
  type BaseFacilityProjection,
  type BaseLiquidationProjection,
  type BaseMultiplierProjection,
  type BaseOrderProjection,
  type BaseProjectionSnapshot,
  type BaseRouteExecution,
  type BaseSwapRouteExecution,
  type BaseTokenProjection,
  type BaseAnnouncementProjection,
  type BaseRedemptionProjection,
  type BaseWithdrawalProjection,
} from './types';

export class BaseProjector {
  private readonly projected = new Map<string, BaseChainEvent>();
  private readonly routes = new Map<string, BaseRouteExecution>();
  private readonly swapRoutes = new Map<string, BaseSwapRouteExecution>();
  private readonly liquidations = new Map<string, BaseLiquidationProjection>();
  private readonly orders = new Map<string, BaseOrderProjection>();
  private readonly facilities = new Map<string, BaseFacilityProjection>();
  private readonly tokens = new Map<string, BaseTokenProjection>();
  private readonly signerAuthorizations = new Map<string, Readonly<Record<string, boolean>>>();
  private readonly canonicalMultiplierTransactions = new Set<string>();

  apply(events: readonly BaseChainEvent[]): void {
    const canonicalInBatch = new Set(
      events
        .filter((event) => event.eventName === 'UIMultiplierUpdated')
        .map((event) => tokenTransactionKey(event)),
    );

    for (const event of events) {
      const key = eventKey(event);
      const previous = this.projected.get(key);
      if (previous) {
        if (stableJson(previous) !== stableJson(event)) throw new Error('EVENT_CONFLICT');
        continue;
      }
      this.projected.set(key, event);
      this.project(event, canonicalInBatch.has(tokenTransactionKey(event)));
    }
  }

  events(): readonly BaseChainEvent[] {
    return [...this.projected.values()].sort(compareEvents);
  }

  snapshot(): BaseProjectionSnapshot {
    return {
      routeExecutions: [...this.routes.values()],
      swapRouteExecutions: [...this.swapRoutes.values()],
      liquidations: Object.fromEntries(this.liquidations),
      orders: Object.fromEntries(this.orders),
      facilities: Object.fromEntries(this.facilities),
      tokens: Object.fromEntries(this.tokens),
    };
  }

  private project(event: BaseChainEvent, canonicalInBatch: boolean): void {
    switch (event.eventName) {
      case 'RouteFilled': this.projectRoute(event); return;
      case 'SwapRouteFilled': this.projectSwapRoute(event); return;
      case 'Fill': this.projectFill(event); return;
      case 'SwapFilled': this.projectSwapFill(event); return;
      case 'Cancel': this.projectCancel(event); return;
      case 'SignerUpdated': this.projectSigner(event); return;
      case 'FacilityRegistered': this.projectFacilityRegistered(event); return;
      case 'FacilityPaused': this.projectFacilityFlag(event, 'paused'); return;
      case 'FacilityRevoked': this.projectFacilityFlag(event, 'revoked'); return;
      case 'Deposit': this.projectDeposit(event); return;
      case 'Withdraw': this.projectWithdraw(event); return;
      case 'WithdrawQueued': this.projectWithdrawQueued(event); return;
      case 'WithdrawClaimed': this.projectWithdrawClaimed(event); return;
      case 'VenueAllocation': this.projectAllocation(event); return;
      case 'InventoryAcquired': this.projectInventory(event); return;
      case 'StockPriceUpdated': this.projectStockPrice(event); return;
      case 'StockMultiplierUpdated': this.projectStockMultiplier(event); return;
      case 'RedemptionLotBooked': this.projectRedemptionBooked(event); return;
      case 'RedemptionSettled': this.projectRedemptionSettled(event); return;
      case 'Paused': this.projectPaused(event, true); return;
      case 'Unpaused': this.projectPaused(event, false); return;
      case 'Announcement': this.projectAnnouncement(event); return;
      case 'EndAnnouncement': this.projectEndAnnouncement(event); return;
      case 'MultiplierUpdated': this.projectLegacyMultiplier(event, canonicalInBatch); return;
      case 'UIMultiplierUpdated': this.projectCanonicalMultiplier(event); return;
      case 'UIMultiplierUpdateCancelled': this.projectMultiplierCancellation(event); return;
      default: return;
    }
  }

  private projectRoute(event: BaseChainEvent): void {
    const args = event.args;
    const rfqId = requiredString(args.rfqId, 'rfqId');
    const route: BaseRouteExecution = {
      eventKey: eventKey(event),
      chainId: event.chainId,
      txHash: String(event.txHash),
      logIndex: event.logIndex,
      rfqId,
      winner: normalizeAddress(requiredString(args.winner, 'winner')),
      recipient: normalizeAddress(requiredString(args.recipient, 'recipient')),
      adapter: normalizeAddress(requiredString(args.adapter, 'adapter')),
      repayAssets: decimalString(args.repayAssets),
      collateralSeized: decimalString(args.collateralSeized),
      fee: decimalString(args.fee),
      blockNumber: event.blockNumber.toString(),
    };
    this.routes.set(route.eventKey, route);
    const previous = this.liquidations.get(rfqId);
    this.liquidations.set(rfqId, {
      rfqId,
      ...previous,
      routeTxHash: route.txHash,
      routeLogIndex: route.logIndex,
      winner: route.winner,
      recipient: route.recipient,
      adapter: route.adapter,
      repayAssets: route.repayAssets,
      collateralSeized: route.collateralSeized,
      fee: route.fee,
    });
  }

  private projectSwapRoute(event: BaseChainEvent): void {
    const args = event.args;
    const route: BaseSwapRouteExecution = {
      eventKey: eventKey(event),
      chainId: event.chainId,
      txHash: String(event.txHash),
      logIndex: event.logIndex,
      requestId: requiredString(args.requestId, 'requestId'),
      taker: normalizeAddress(requiredString(args.taker, 'taker')),
      recipient: normalizeAddress(requiredString(args.recipient, 'recipient')),
      stockToken: normalizeAddress(requiredString(args.stockToken, 'stockToken')),
      usdcToken: normalizeAddress(requiredString(args.usdcToken, 'usdcToken')),
      stockAmount: decimalString(args.stockAmount),
      boughtUsdc: decimalString(args.boughtUsdc),
      fee: decimalString(args.fee),
      blockNumber: event.blockNumber.toString(),
    };
    this.swapRoutes.set(route.eventKey, route);
  }

  private projectFill(event: BaseChainEvent): void {
    const args = event.args;
    const orderHash = requiredString(args.orderHash, 'orderHash');
    const previous = this.orders.get(orderHash);
    const maker = stringValue(args.maker) ? normalizeAddress(String(args.maker)) : previous?.maker;
    this.orders.set(orderHash, {
      orderHash,
      maker,
      status: 'filled',
      filledAssets: addDecimal(previous?.filledAssets ?? '0', decimalString(args.repayAssets)),
      signerAuthorization: maker ? this.signerAuthorizations.get(maker) ?? previous?.signerAuthorization ?? {} : previous?.signerAuthorization ?? {},
      lastEventKey: eventKey(event),
      ...(previous?.kind ? { kind: previous.kind } : { kind: 'LIQUIDATION' }),
      ...(previous?.stockToken ? { stockToken: previous.stockToken } : {}),
      ...(previous?.usdcToken ? { usdcToken: previous.usdcToken } : {}),
      ...(previous?.filledStock ? { filledStock: previous.filledStock } : {}),
      ...(previous?.filledUsdc ? { filledUsdc: previous.filledUsdc } : {}),
      ...(previous?.lastTaker ? { lastTaker: previous.lastTaker } : {}),
    });
  }

  private projectSwapFill(event: BaseChainEvent): void {
    const args = event.args;
    const orderHash = requiredString(args.orderHash, 'orderHash');
    const previous = this.orders.get(orderHash);
    const maker = normalizeAddress(requiredString(args.maker, 'maker'));
    const stockToken = normalizeAddress(requiredString(args.stockToken, 'stockToken'));
    const usdcToken = normalizeAddress(requiredString(args.usdcToken, 'usdcToken'));
    const filledStock = addDecimal(previous?.filledStock ?? '0', decimalString(args.stockAmount));
    const filledUsdc = addDecimal(previous?.filledUsdc ?? '0', decimalString(args.usdcAmount));
    this.orders.set(orderHash, {
      orderHash,
      maker,
      status: 'active',
      filledAssets: previous?.filledAssets ?? '0',
      signerAuthorization: this.signerAuthorizations.get(maker) ?? previous?.signerAuthorization ?? {},
      lastEventKey: eventKey(event),
      kind: 'SWAP',
      stockToken,
      usdcToken,
      filledStock,
      filledUsdc,
      lastTaker: normalizeAddress(requiredString(args.taker, 'taker')),
    });
  }

  private projectCancel(event: BaseChainEvent): void {
    const args = event.args;
    const orderHash = requiredString(args.orderHash, 'orderHash');
    const previous = this.orders.get(orderHash);
    const maker = stringValue(args.maker) ?? previous?.maker;
    this.orders.set(orderHash, {
      orderHash,
      maker,
      status: 'cancelled',
      filledAssets: previous?.filledAssets ?? '0',
      signerAuthorization: maker ? this.signerAuthorizations.get(maker) ?? previous?.signerAuthorization ?? {} : previous?.signerAuthorization ?? {},
      lastEventKey: eventKey(event),
      ...(previous?.kind ? { kind: previous.kind } : {}),
      ...(previous?.stockToken ? { stockToken: previous.stockToken } : {}),
      ...(previous?.usdcToken ? { usdcToken: previous.usdcToken } : {}),
      ...(previous?.filledStock ? { filledStock: previous.filledStock } : {}),
      ...(previous?.filledUsdc ? { filledUsdc: previous.filledUsdc } : {}),
      ...(previous?.lastTaker ? { lastTaker: previous.lastTaker } : {}),
    });
  }

  private projectSigner(event: BaseChainEvent): void {
    const args = event.args;
    const maker = normalizeAddress(requiredString(args.maker, 'maker'));
    const signer = normalizeAddress(requiredString(args.signer, 'signer'));
    const authorization = {
      ...(this.signerAuthorizations.get(maker) ?? {}),
      [signer]: Boolean(args.authorized),
    };
    this.signerAuthorizations.set(maker, authorization);
    for (const [orderHash, order] of this.orders) {
      if (order.maker !== maker) continue;
      this.orders.set(orderHash, {
        ...order,
        signerAuthorization: { ...order.signerAuthorization, ...authorization },
        lastEventKey: eventKey(event),
      });
    }
    const orderHash = `signer:${maker}`;
    const previous = this.orders.get(orderHash);
    this.orders.set(orderHash, {
      orderHash,
      maker,
      status: previous?.status ?? 'active',
      filledAssets: previous?.filledAssets ?? '0',
      signerAuthorization: { ...previous?.signerAuthorization, ...authorization },
      lastEventKey: eventKey(event),
    });
  }

  private projectFacilityRegistered(event: BaseChainEvent): void {
    const facility = normalizeAddress(requiredString(event.args.facility, 'facility'));
    this.facilities.set(facility, {
      ...emptyFacility(facility),
      curator: stringValue(event.args.curator) ? normalizeAddress(String(event.args.curator)) : undefined,
      registered: true,
    });
  }

  private projectFacilityFlag(event: BaseChainEvent, flag: 'paused' | 'revoked'): void {
    const facility = normalizeAddress(requiredString(event.args.facility, 'facility'));
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    this.facilities.set(facility, {
      ...previous,
      registered: previous.registered || flag === 'revoked',
      [flag]: true,
    });
  }

  private projectDeposit(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    this.facilities.set(facility, { ...previous, deposits: addDecimal(previous.deposits, decimalString(event.args.assets)) });
  }

  private projectWithdraw(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    this.facilities.set(facility, { ...previous, withdrawals: addDecimal(previous.withdrawals, decimalString(event.args.assets)) });
  }

  private projectWithdrawQueued(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    const requestId = decimalString(event.args.requestId);
    const queued: BaseWithdrawalProjection = {
      requestId,
      owner: normalizeAddress(requiredString(event.args.owner, 'owner')),
      assets: decimalString(event.args.assets),
      shares: decimalString(event.args.shares),
      status: 'queued',
      queuedBlock: event.blockNumber.toString(10),
    };
    this.facilities.set(facility, {
      ...previous,
      queuedWithdrawals: addDecimal(previous.queuedWithdrawals, queued.assets),
      withdrawalRequests: { ...previous.withdrawalRequests, [requestId]: queued },
    });
  }

  private projectWithdrawClaimed(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    const requestId = decimalString(event.args.requestId);
    const claimedAssets = decimalString(event.args.assets);
    const prior = previous.withdrawalRequests[requestId];
    const request: BaseWithdrawalProjection = {
      requestId,
      owner: prior?.owner ?? normalizeAddress(requiredString(event.args.owner, 'owner')),
      assets: prior?.assets ?? claimedAssets,
      shares: prior?.shares ?? '0',
      claimedAssets,
      status: 'claimed',
      ...(prior?.queuedBlock ? { queuedBlock: prior.queuedBlock } : {}),
      claimedBlock: event.blockNumber.toString(10),
    };
    this.facilities.set(facility, {
      ...previous,
      claimedWithdrawals: addDecimal(previous.claimedWithdrawals, claimedAssets),
      queuedWithdrawals: subtractDecimal(previous.queuedWithdrawals, claimedAssets),
      withdrawalRequests: { ...previous.withdrawalRequests, [requestId]: request },
    });
  }

  private projectAllocation(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const adapter = normalizeAddress(requiredString(event.args.adapter, 'adapter'));
    const amount = decimalString(event.args.assets);
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    const current = previous.allocatedByAdapter[adapter] ?? '0';
    const assets = Boolean(event.args.allocating) ? addDecimal(current, amount) : subtractDecimal(current, amount);
    this.facilities.set(facility, { ...previous, allocatedByAdapter: { ...previous.allocatedByAdapter, [adapter]: assets } });
  }

  private projectInventory(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const token = normalizeAddress(requiredString(event.args.token, 'token'));
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    const current = previous.inventoryByToken[token] ?? { amount: '0', usdcPaid: '0' };
    this.facilities.set(facility, {
      ...previous,
      inventoryByToken: {
        ...previous.inventoryByToken,
        [token]: {
          amount: addDecimal(current.amount, decimalString(event.args.amount)),
          usdcPaid: addDecimal(current.usdcPaid, decimalString(event.args.usdcPaid)),
        },
      },
    });
  }

  private projectStockPrice(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const token = normalizeAddress(requiredString(event.args.token, 'token'));
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    this.facilities.set(facility, {
      ...previous,
      stockPrices: {
        ...previous.stockPrices,
        [token]: {
          priceWad: decimalString(event.args.priceWad),
          updatedAt: decimalString(event.args.updatedAt),
        },
      },
    });
  }

  private projectStockMultiplier(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const token = normalizeAddress(requiredString(event.args.token, 'token'));
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    this.facilities.set(facility, {
      ...previous,
      stockMultipliers: { ...previous.stockMultipliers, [token]: decimalString(event.args.multiplierWad) },
    });
  }

  private projectRedemptionBooked(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const lotId = decimalString(event.args.lotId);
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    const lot: BaseRedemptionProjection = {
      lotId,
      token: normalizeAddress(requiredString(event.args.token, 'token')),
      amount: decimalString(event.args.amount),
      acquisitionCost: decimalString(event.args.acquisitionCost),
      operator: normalizeAddress(requiredString(event.args.operator, 'operator')),
      status: 'booked',
    };
    this.facilities.set(facility, { ...previous, redemptionLots: { ...previous.redemptionLots, [lotId]: lot } });
  }

  private projectRedemptionSettled(event: BaseChainEvent): void {
    const facility = normalizeAddress(event.address);
    const lotId = decimalString(event.args.lotId);
    const previous = this.facilities.get(facility) ?? emptyFacility(facility);
    const prior = previous.redemptionLots[lotId];
    if (!prior) return;
    const pnl = signedDecimalString(event.args.realizedPnl);
    this.facilities.set(facility, {
      ...previous,
      redemptionLots: {
        ...previous.redemptionLots,
        [lotId]: { ...prior, status: 'settled', usdcProceeds: decimalString(event.args.usdcProceeds), realizedPnl: pnl },
      },
      realizedProfit: pnl.startsWith('-') ? previous.realizedProfit : addDecimal(previous.realizedProfit, pnl),
      realizedLoss: pnl.startsWith('-') ? addDecimal(previous.realizedLoss, pnl.slice(1)) : previous.realizedLoss,
    });
  }

  private projectPaused(event: BaseChainEvent, paused: boolean): void {
    const token = normalizeAddress(event.address);
    const previous = this.tokens.get(token) ?? emptyToken(token);
    const features = numberArray(event.args.features);
    const current = new Set(previous.pausedFeatures);
    for (const feature of features) {
      if (paused) current.add(feature);
      else current.delete(feature);
    }
    this.tokens.set(token, { ...previous, pausedFeatures: [...current].sort((left, right) => left - right) });
  }

  private projectAnnouncement(event: BaseChainEvent): void {
    const token = normalizeAddress(event.address);
    const previous = this.tokens.get(token) ?? emptyToken(token);
    const announcement: BaseAnnouncementProjection = {
      id: requiredString(event.args.id, 'id'),
      description: String(event.args.description ?? ''),
      uri: String(event.args.uri ?? ''),
      caller: normalizeAddress(requiredString(event.args.caller, 'caller')),
      open: true,
    };
    this.tokens.set(token, { ...previous, announcements: { ...previous.announcements, [announcement.id]: announcement }, announcement });
  }

  private projectEndAnnouncement(event: BaseChainEvent): void {
    const token = normalizeAddress(event.address);
    const previous = this.tokens.get(token) ?? emptyToken(token);
    const id = requiredString(event.args.id, 'id');
    const prior = previous.announcements[id];
    if (!prior) return;
    const announcement = { ...prior, open: false };
    this.tokens.set(token, { ...previous, announcements: { ...previous.announcements, [id]: announcement }, announcement });
  }

  private projectLegacyMultiplier(event: BaseChainEvent, canonicalInBatch: boolean): void {
    const token = normalizeAddress(event.address);
    const transactionKey = tokenTransactionKey(event);
    if (this.canonicalMultiplierTransactions.has(transactionKey) || canonicalInBatch) return;
    const previous = this.tokens.get(token) ?? emptyToken(token);
    const multiplier: BaseMultiplierProjection = {
      newMultiplier: decimalString(event.args.multiplier),
      source: 'legacy',
      eventKey: eventKey(event),
    };
    this.tokens.set(token, { ...previous, multiplier });
  }

  private projectCanonicalMultiplier(event: BaseChainEvent): void {
    const token = normalizeAddress(event.address);
    this.canonicalMultiplierTransactions.add(tokenTransactionKey(event));
    const previous = this.tokens.get(token) ?? emptyToken(token);
    const multiplier: BaseMultiplierProjection = {
      oldMultiplier: decimalString(event.args.oldMultiplier),
      newMultiplier: decimalString(event.args.newMultiplier),
      effectiveAt: decimalString(event.args.effectiveAtTimestamp ?? event.args.effectiveAt),
      source: 'canonical',
      eventKey: eventKey(event),
    };
    this.tokens.set(token, { ...previous, multiplier });
  }

  private projectMultiplierCancellation(event: BaseChainEvent): void {
    const token = normalizeAddress(event.address);
    const previous = this.tokens.get(token) ?? emptyToken(token);
    this.tokens.set(token, {
      ...previous,
      multiplierCancellation: {
        multiplier: decimalString(event.args.cancelledMultiplier),
        effectiveAt: decimalString(event.args.cancelledEffectiveAt),
      },
    });
  }
}

export function eventKey(event: BaseChainEvent): string {
  return `${event.chainId}:${event.txHash}:${event.logIndex}`;
}

function tokenTransactionKey(event: BaseChainEvent): string {
  return `${event.chainId}:${event.txHash}:${normalizeAddress(event.address)}`;
}

function compareEvents(left: BaseChainEvent, right: BaseChainEvent): number {
  return Number(left.blockNumber - right.blockNumber) || left.logIndex - right.logIndex;
}

function emptyFacility(facility: string): BaseFacilityProjection {
  return {
    facility,
    registered: false,
    paused: false,
    revoked: false,
    deposits: '0',
    withdrawals: '0',
    queuedWithdrawals: '0',
    claimedWithdrawals: '0',
    withdrawalRequests: {},
    allocatedByAdapter: {},
    inventoryByToken: {},
    stockPrices: {},
    stockMultipliers: {},
    redemptionLots: {},
    realizedProfit: '0',
    realizedLoss: '0',
  };
}

function emptyToken(token: string): BaseTokenProjection {
  return { token, pausedFeatures: [], announcements: {} };
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`EVENT_FIELD_MISSING:${field}`);
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value === undefined || value === null ? undefined : String(value);
}

function decimalString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('EVENT_INTEGER_INVALID');
}

function signedDecimalString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value).toString(10);
  throw new Error('EVENT_INTEGER_INVALID');
}

function addDecimal(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString(10);
}

function subtractDecimal(left: string, right: string): string {
  const result = BigInt(left) - BigInt(right);
  return (result < 0n ? 0n : result).toString(10);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('EVENT_FEATURES_INVALID');
  return value.map((entry) => {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0) return entry;
    if (typeof entry === 'bigint' && entry >= 0n) return Number(entry);
    if (typeof entry === 'string' && /^\d+$/.test(entry)) return Number(entry);
    throw new Error('EVENT_FEATURE_INVALID');
  });
}

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function stableJson(value: unknown): string {
  if (typeof value === 'bigint') return `bigint:${value.toString(10)}`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
