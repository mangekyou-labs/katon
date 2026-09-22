import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import {
  SWAP_AUCTION_WINDOW_MS,
  facilityQuoteHash,
  rankSwapQuotes,
  hashSwapOrder,
  hashLiquidationFundingOrder,
  rankLiquidation,
  type FacilitySwapQuote,
  type FacilityLiquidationQuote,
  type LiquidationRankInput,
  type MakerSwapQuote,
  type RankedLiquidationRoute,
  type RankedSwapRoute,
  type SwapQuoteRequest,
  type ExternalSwapQuote,
} from '../../../packages/base-core/src/index';
import { RFQ_ROUTER_EXECUTE_ABI, RFQ_ROUTER_SWAP_EXECUTE_ABI } from '../../../packages/base-contracts/src/index';
import type { BaseRepository } from './ports';
import type {
  BaseApiConfig,
  BaseAuthContext,
  BaseClock,
  BaseNotificationPort,
  BaseRouteResponse,
  BaseSignaturePort,
  BaseSnapshotPort,
  BaseSwapQuotePort,
  BaseSwapPreflightPort,
  BaseSwapPreflightResult,
  BaseSwapTransaction,
  BaseSwapQuoteResponse,
  EligibilityPort,
  StoredBid,
  StoredLiquidation,
  StoredRoute,
} from './types';
import {
  domainFor,
  orderToStored,
  parseBidRequest,
  parseLiquidationRequest,
  parseStandingBidRequest,
  parseSwapQuoteRequest,
  parseSwapOrderRequest,
  storedToOrder,
  storedToSwapOrder,
  swapDomainFor,
  swapOrderToStored,
  ZERO_ADDRESS,
  ZERO_HASH,
  type BidRequestInput,
} from './validation';

export class BaseApiService {
  constructor(
    private readonly config: BaseApiConfig,
    private readonly repository: BaseRepository,
    private readonly snapshot: BaseSnapshotPort,
    private readonly signatures: BaseSignaturePort,
    private readonly clock: BaseClock,
    private readonly notifications: BaseNotificationPort,
    private readonly swapQuotes?: BaseSwapQuotePort,
    private readonly eligibility?: EligibilityPort,
    private readonly swapPreflight?: BaseSwapPreflightPort,
  ) {}

  /**
   * Collect a seller-private one-second stock auction. The service never
   * submits a wallet transaction and never exposes losing maker prices to the
   * caller; only the recommended route and executable alternatives are
   * returned.
   */
  async quoteSwap(raw: unknown, auth: BaseAuthContext): Promise<BaseSwapQuoteResponse> {
    const input = parseSwapQuoteRequest(raw);
    requireIdentity(auth, input.taker, false);
    const now = this.clock.nowSeconds();
    if (input.deadline <= now) throw new Error('SWAP_EXPIRED');
    if (input.sellAmount === 0n || input.minBuyAmount === 0n || input.recipient === ZERO_ADDRESS) throw new Error('SWAP_REQUEST_INVALID');
    if (this.config.nativeUsdcAddress && input.usdcToken.toLowerCase() !== this.config.nativeUsdcAddress.toLowerCase()) throw new Error('NATIVE_USDC_REQUIRED');
    if (this.config.chainId === 8453 && !this.config.forkQa) {
      if (this.config.mainnetEnabled !== true || this.config.deploymentConfigured === false) throw new Error('MAINNET_DISABLED');
      if (auth.kind !== 'siwe' || !this.eligibility) throw new Error('ELIGIBILITY_REQUIRED');
    }

    let eligibilityRecord: BaseSwapQuoteResponse['eligibility'];
    if (this.config.chainId === 8453 && !this.config.forkQa) {
      const proof = await this.eligibility!.attest(input.taker, input.stockToken);
      if (!proof.eligible || !proof.attestationId || proof.expiresAt === undefined || proof.expiresAt <= now) throw new Error('ELIGIBILITY_DENIED');
      eligibilityRecord = { attestationId: proof.attestationId, expiresAt: proof.expiresAt.toString(10) };
    }

    const openedAtMs = this.clock.nowMilliseconds();
    const cutoffAtMs = openedAtMs + SWAP_AUCTION_WINDOW_MS;
    const requestId = keccak256(encodeAbiParameters(
      [
        { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
        { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
      ],
      [input.stockToken, input.usdcToken, input.sellAmount, input.minBuyAmount, input.taker, input.recipient, input.deadline, BigInt(openedAtMs)],
    ));
    const collection = await this.collectSwapQuotes({
      requestId,
      stockToken: input.stockToken,
      usdcToken: input.usdcToken,
      sellAmount: input.sellAmount,
      minBuyAmount: input.minBuyAmount,
      taker: input.taker,
      recipient: input.recipient,
      deadline: input.deadline,
      now,
      auctionOpenedAtMs: openedAtMs,
      auctionCutoffAtMs: cutoffAtMs,
      feeBps: this.config.feeBps,
      chainId: this.config.chainId,
      decisionBlock: 0n,
      decisionBlockHash: ZERO_HASH,
    });
    const requestBase: SwapQuoteRequest = {
      requestId,
      stockToken: input.stockToken,
      usdcToken: input.usdcToken,
      sellAmount: input.sellAmount,
      minBuyAmount: input.minBuyAmount,
      taker: input.taker,
      recipient: input.recipient,
      deadline: input.deadline,
      now,
      auctionOpenedAtMs: openedAtMs,
      auctionCutoffAtMs: cutoffAtMs,
      feeBps: this.config.feeBps,
      chainId: this.config.chainId,
      decisionBlock: 0n,
      decisionBlockHash: ZERO_HASH,
    };
    const quoteInput = {
      makerQuotes: collection.makerQuotes ?? [],
      facilityQuotes: collection.facilityQuotes ?? [],
      externalQuotes: collection.externalQuotes ?? [],
    } as const;
    const ranked = rankSwapQuotes({ request: requestBase, ...quoteInput });
    let rankedForResponse = ranked;
    let selected = ranked.recommended;
    let preflight: BaseSwapPreflightResult | undefined;
    const legacyPreflight = this.legacyPreflight(collection);
    if (selected) {
      const authoritative = this.swapPreflight
        && typeof this.swapPreflight.captureSnapshot === 'function'
        && typeof this.swapPreflight.simulateInternalRoute === 'function';
      if (authoritative) {
        const snapshot = await this.swapPreflight!.captureSnapshot();
        const request = { ...requestBase, decisionBlock: snapshot.decisionBlock, decisionBlockHash: snapshot.decisionBlockHash };
        const pinnedRanked = rankSwapQuotes({ request, ...quoteInput });
        let internalPreflight: BaseSwapPreflightResult | undefined;
        let lastError: unknown;
        if (pinnedRanked.internal) {
          try {
            const transaction = this.internalSwapTransaction(pinnedRanked.internal, request);
            internalPreflight = await this.swapPreflight!.simulateInternalRoute({
              request,
              route: pinnedRanked.internal,
              snapshot,
              allowanceTarget: this.config.settlementAddress,
              transaction,
            });
          } catch (error) {
            lastError = error;
          }
        }
        preflight = internalPreflight ?? { ...snapshot, allowanceTarget: this.config.settlementAddress };
        if (!internalPreflight && pinnedRanked.external.length === 0) {
          throw new Error(stablePreflightFailure(lastError));
        }
        if (!internalPreflight && pinnedRanked.external.length > 0) {
          // An internal route that cannot be simulated is never returned. The
          // highest-ranked venue packet remains a safe, quote-only fallback.
          const external = pinnedRanked.external;
          rankedForResponse = {
            status: 'WINNER',
            recommended: external[0],
            alternatives: external.slice(1),
            external,
          };
          selected = external[0];
        } else {
          rankedForResponse = pinnedRanked;
          selected = pinnedRanked.recommended;
        }
      } else if (legacyPreflight && !this.swapPreflight && this.config.deploymentConfigured !== true) {
        // Compatibility for old in-memory fixtures. Production-configured
        // services never accept provider-supplied block metadata.
        preflight = legacyPreflight;
      } else if (!this.swapPreflight) {
        throw new Error('PREFLIGHT_UNAVAILABLE');
      } else {
        let lastError: unknown;
        const attempted = uniqueSwapRoutes([ranked.recommended, ...ranked.alternatives, ...ranked.external]);
        for (const candidate of attempted) {
          try {
            preflight = await this.preflightSwapRoute(candidate, requestBase);
            selected = candidate;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!preflight) throw new Error(stablePreflightFailure(lastError));
      }
    }
    const request: SwapQuoteRequest = preflight
      ? { ...requestBase, decisionBlock: preflight.decisionBlock, decisionBlockHash: preflight.decisionBlockHash }
      : requestBase;
    // Re-rank with the server-owned decision hash so the internal route id and
    // calldata commit to exactly the block that was simulated.
    const finalRanked = preflight && rankedForResponse === ranked ? rankSwapQuotes({ request, ...quoteInput }) : rankedForResponse;
    if (selected) {
      const resolved = findEquivalentSwapRoute(finalRanked, selected);
      if (resolved) selected = resolved;
    }
    if (selected && (!preflight || preflight.decisionBlock === 0n)) throw new Error('SIMULATION_REQUIRED');
    const simulationBlock = preflight?.simulationBlock ?? 0n;
    const simulationBlockHash = preflight?.simulationBlockHash ?? ZERO_HASH;
    return {
      requestId,
      chainId: String(this.config.chainId),
      stockToken: input.stockToken,
      usdcToken: input.usdcToken,
      sellAmount: input.sellAmount.toString(10),
      minBuyAmount: input.minBuyAmount.toString(10),
      taker: input.taker,
      recipient: input.recipient,
      feeBps: this.config.feeBps.toString(10),
      auctionOpenedAtMs: openedAtMs,
      auctionCutoffAtMs: cutoffAtMs,
      decisionBlock: (preflight?.decisionBlock ?? 0n).toString(10),
      decisionBlockHash: preflight?.decisionBlockHash ?? ZERO_HASH,
      simulationBlock: simulationBlock.toString(10),
      simulationBlockHash,
      ...(eligibilityRecord ? { eligibility: eligibilityRecord } : {}),
      status: selected ? 'WINNER' : finalRanked.status,
      ...(!selected && finalRanked.reason ? { reason: finalRanked.reason } : {}),
      ...(selected ? { recommended: this.serializeSwapRoute(selected, request) } : {}),
      alternatives: finalRanked.alternatives
        .filter((route) => !selected || !sameSwapRoute(route, selected))
        .map((route) => this.serializeSwapRoute(route, request)),
      external: finalRanked.external
        .filter((route) => !selected || !sameSwapRoute(route, selected))
        .map((route) => this.serializeSwapRoute(route, request)),
    };
  }

  /** Register a v2 maker order without exposing its price to other makers. */
  async swapOrder(raw: unknown, auth: BaseAuthContext): Promise<Readonly<Record<string, unknown>>> {
    const input = parseSwapOrderRequest(raw);
    if (input.action === 'revoke') {
      if (!input.orderHash || !this.repository.revokeSwapOrder) throw new Error('SWAP_ORDER_STORAGE_UNAVAILABLE');
      const revoked = await this.repository.revokeSwapOrder(auth.identity, input.orderHash);
      if (!revoked) throw new Error('SWAP_ORDER_NOT_FOUND');
      return { action: 'revoke', orderHash: input.orderHash, status: 'revoked' };
    }
    if (!input.order || !input.signature || input.remainingCapacity === undefined) throw new Error('SWAP_ORDER_REQUIRED');
    if (!this.repository.insertSwapOrder) throw new Error('SWAP_ORDER_STORAGE_UNAVAILABLE');
    const order = input.order;
    requireIdentity(auth, order.maker, true);
    const now = this.clock.nowSeconds();
    if (order.stockAmount === 0n || order.usdcAmount === 0n || input.remainingCapacity === 0n || input.remainingCapacity > order.stockAmount) throw new Error('ORDER_CAPACITY');
    if (order.expiry <= now) throw new Error('ORDER_EXPIRED');
    if (order.fillMode < 0 || order.fillMode > 1) throw new Error('ORDER_INTEGER_INVALID');
    if (order.fillMode === 0 && input.remainingCapacity !== order.stockAmount) throw new Error('ORDER_CAPACITY');
    if (order.feeCapBps < Number(this.config.feeBps)) throw new Error('FEE_CAP');
    if (this.config.nativeUsdcAddress && order.usdcToken.toLowerCase() !== this.config.nativeUsdcAddress.toLowerCase()) throw new Error('NATIVE_USDC_REQUIRED');
    if (order.rfqId === ZERO_HASH && order.allowedTaker !== ZERO_ADDRESS) throw new Error('STANDING_TAKER_INVALID');
    if (order.rfqId !== ZERO_HASH && order.rfqId.length !== 66) throw new Error('RFQ_INVALID');
    if (order.signer !== order.maker && !(await this.signatures.isDelegatedSigner(order.maker, order.signer))) throw new Error('SIGNER_NOT_DELEGATED');
    const domain = swapDomainFor(this.config);
    if (!this.signatures.verifySwapOrder) throw new Error('SWAP_SIGNATURE_UNAVAILABLE');
    const verification = await this.signatures.verifySwapOrder(order, input.signature, domain);
    if (!verification.valid) throw new Error(verification.reason ?? 'SIGNATURE_INVALID');
    const orderHash = hashSwapOrder(order, domain);
    const state = this.signatures.getSwapState
      ? await this.signatures.getSwapState(orderHash, order.maker)
      : { cancelled: false, filled: 0n };
    if (state.cancelled || state.filled >= order.stockAmount || state.filled + input.remainingCapacity > order.stockAmount) throw new Error('ORDER_CAPACITY');
    const stored: import('./types').StoredSwapOrder = {
      orderHash,
      maker: order.maker,
      order: swapOrderToStored(order),
      signature: input.signature,
      remainingCapacity: input.remainingCapacity.toString(10),
      timestamp: now.toString(10),
      standing: order.rfqId === ZERO_HASH,
    };
    await this.repository.insertSwapOrder(stored);
    return {
      action: 'register',
      orderHash,
      maker: order.maker,
      order: stored.order,
      signature: input.signature,
      remainingCapacity: stored.remainingCapacity,
      standing: stored.standing,
      status: 'registered',
    };
  }

  private async collectSwapQuotes(request: SwapQuoteRequest): Promise<import('./types').SwapQuoteCollection> {
    const source = this.swapQuotes;
    let collection: import('./types').SwapQuoteCollection = {};
    if (source) {
      const collect = source.collect
        ? source.collect(request)
        : Promise.all([
          source.getMakerQuotes ? source.getMakerQuotes(request).catch(() => []) : Promise.resolve<readonly MakerSwapQuote[]>([]),
          source.getFacilityQuotes ? source.getFacilityQuotes(request).catch(() => []) : Promise.resolve<readonly FacilitySwapQuote[]>([]),
          source.getExternalQuotes ? source.getExternalQuotes(request).catch(() => []) : Promise.resolve<readonly ExternalSwapQuote[]>([]),
        ]).then(([makers, facilities, external]) => ({ makerQuotes: makers, facilityQuotes: facilities, externalQuotes: external }));
      const remainingMs = Math.max(0, request.auctionCutoffAtMs - this.clock.nowMilliseconds());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        collection = await Promise.race([
          collect.catch((error) => {
            if (error instanceof Error && error.message === 'SWAP_PROVIDER_METADATA_FORBIDDEN') throw error;
            return {};
          }),
          new Promise<import('./types').SwapQuoteCollection>((resolve) => {
            timer = setTimeout(() => resolve({}), remainingMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (hasProviderMetadata(collection) && (this.swapPreflight || this.config.deploymentConfigured === true)) {
      throw new Error('SWAP_PROVIDER_METADATA_FORBIDDEN');
    }
    const storedMakers = await this.collectStoredSwapQuotes(request);
    return { ...collection, makerQuotes: [...(collection.makerQuotes ?? []), ...storedMakers] };
  }

  private legacyPreflight(collection: import('./types').SwapQuoteCollection): BaseSwapPreflightResult | undefined {
    const record = collection as unknown as Record<string, unknown>;
    const providerPreflight = record.preflight && typeof record.preflight === 'object'
      ? record.preflight as Record<string, unknown>
      : undefined;
    if (providerPreflight?.simulated === false) throw new Error(typeof providerPreflight.code === 'string' ? providerPreflight.code : 'PREFLIGHT_SIMULATION_FAILED');
    const decisionBlock = typeof record.decisionBlock === 'bigint' ? record.decisionBlock : record.simulationBlock;
    const decisionBlockHash = validHash(record.decisionBlockHash) ? record.decisionBlockHash : record.simulationBlockHash;
    const simulationBlock = typeof record.simulationBlock === 'bigint' ? record.simulationBlock : decisionBlock;
    const simulationBlockHash = validHash(record.simulationBlockHash) ? record.simulationBlockHash : decisionBlockHash;
    if (decisionBlock === undefined && simulationBlock === undefined) return undefined;
    if (typeof decisionBlock !== 'bigint' || decisionBlock <= 0n || typeof simulationBlock !== 'bigint' || simulationBlock < decisionBlock) throw new Error('PREFLIGHT_BLOCK_INVALID');
    if (!validHash(decisionBlockHash) || !validHash(simulationBlockHash)) throw new Error('PREFLIGHT_HASH_INVALID');
    return { decisionBlock, decisionBlockHash, simulationBlock, simulationBlockHash, allowanceTarget: this.config.settlementAddress };
  }

  private async preflightSwapRoute(route: RankedSwapRoute, request: SwapQuoteRequest): Promise<BaseSwapPreflightResult> {
    if (!this.swapPreflight?.preflight) throw new Error('PREFLIGHT_UNAVAILABLE');
    const allowanceTarget = route.kind === 'INTERNAL'
      ? this.config.settlementAddress
      : route.transaction.allowanceTarget;
    if (!allowanceTarget || !validAddress(allowanceTarget)) throw new Error('PREFLIGHT_ALLOWANCE_TARGET_INVALID');
    return this.swapPreflight.preflight({
      request,
      allowanceTarget,
      buildTransaction: ({ decisionBlock, decisionBlockHash }): BaseSwapTransaction => {
        if (route.kind === 'EXTERNAL') return {
          to: route.transaction.to,
          data: route.transaction.data,
          value: route.transaction.value,
        };
        const serialized = this.serializeSwapRoute(route, { ...request, decisionBlock, decisionBlockHash });
        const transaction = serialized.transaction;
        if (!transaction || typeof transaction !== 'object') throw new Error('PREFLIGHT_TRANSACTION_INVALID');
        const value = transaction as { readonly to?: unknown; readonly data?: unknown; readonly value?: unknown };
        if (!validAddress(value.to) || typeof value.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value.data) || typeof value.value !== 'string') throw new Error('PREFLIGHT_TRANSACTION_INVALID');
        return { to: value.to, data: value.data as Hex, value: BigInt(value.value) };
      },
    });
  }

  private internalSwapTransaction(route: Extract<RankedSwapRoute, { readonly kind: 'INTERNAL' }>, request: SwapQuoteRequest): BaseSwapTransaction {
    const serialized = this.serializeSwapRoute(route, request);
    const transaction = serialized.transaction;
    if (!transaction || typeof transaction !== 'object') throw new Error('PREFLIGHT_TRANSACTION_INVALID');
    const value = transaction as { readonly to?: unknown; readonly data?: unknown; readonly value?: unknown };
    if (!validAddress(value.to) || typeof value.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value.data) || value.data === '0x' || typeof value.value !== 'string') {
      throw new Error('PREFLIGHT_TRANSACTION_INVALID');
    }
    let numericValue: bigint;
    try {
      numericValue = BigInt(value.value);
    } catch {
      throw new Error('PREFLIGHT_TRANSACTION_INVALID');
    }
    if (numericValue < 0n) throw new Error('PREFLIGHT_TRANSACTION_INVALID');
    return { to: value.to, data: value.data as Hex, value: numericValue };
  }

  private async collectStoredSwapQuotes(request: SwapQuoteRequest): Promise<readonly MakerSwapQuote[]> {
    if (!this.repository.listSwapOrders) return [];
    const domain = swapDomainFor(this.config);
    const orders = await this.repository.listSwapOrders();
    const quotes: MakerSwapQuote[] = [];
    for (const stored of orders) {
      const order = storedToSwapOrder(stored.order);
      if (order.stockToken.toLowerCase() !== request.stockToken.toLowerCase() || order.usdcToken.toLowerCase() !== request.usdcToken.toLowerCase()) continue;
      if (order.rfqId !== ZERO_HASH && order.rfqId.toLowerCase() !== request.requestId.toLowerCase()) continue;
      if (order.allowedTaker !== ZERO_ADDRESS && order.allowedTaker.toLowerCase() !== request.taker.toLowerCase()) continue;
      if (order.expiry <= request.now || BigInt(stored.remainingCapacity) === 0n) continue;
      const receivedAtMs = Number(BigInt(stored.timestamp) * 1_000n);
      if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs > request.auctionCutoffAtMs) continue;
      const state = this.signatures.getSwapState ? await this.signatures.getSwapState(stored.orderHash, order.maker) : { cancelled: false, filled: 0n };
      if (state.cancelled || state.filled >= order.stockAmount || state.filled + BigInt(stored.remainingCapacity) > order.stockAmount) continue;
      if (this.signatures.verifySwapOrder) {
        const verification = await this.signatures.verifySwapOrder(order, stored.signature, domain);
        if (!verification.valid) continue;
      } else continue;
      quotes.push({
        source: 'LP',
        quoteId: stored.orderHash,
        order,
        signature: stored.signature,
        capacity: BigInt(stored.remainingCapacity),
        receivedAtMs,
        gasEstimateUsdc: this.config.conservativeGasUsdc ?? 0n,
      });
    }
    return quotes;
  }

  private serializeSwapRoute(route: RankedSwapRoute, request: SwapQuoteRequest): Readonly<Record<string, unknown>> {
    if (route.kind === 'EXTERNAL') {
      return {
        kind: route.kind,
        source: route.source,
        routeId: route.routeId,
        stockAmount: route.stockAmount.toString(10),
        grossUsdc: route.grossUsdc.toString(10),
        guaranteedUsdc: route.guaranteedUsdc.toString(10),
        fee: route.fee.toString(10),
        gasEstimateUsdc: route.gasEstimateUsdc.toString(10),
        effectiveUsdc: route.effectiveUsdc.toString(10),
        expiry: route.expiry.toString(10),
        decisionBlock: request.decisionBlock.toString(10),
        decisionBlockHash: request.decisionBlockHash,
        transaction: {
          to: route.transaction.to,
          data: route.transaction.data,
          value: route.transaction.value.toString(10),
          ...(route.transaction.allowanceTarget ? { allowanceTarget: route.transaction.allowanceTarget } : {}),
          ...(route.transaction.chainId === undefined ? {} : { chainId: route.transaction.chainId }),
          ...(route.transaction.recipient ? { recipient: route.transaction.recipient } : {}),
          ...(route.transaction.stockToken ? { stockToken: route.transaction.stockToken } : {}),
          ...(route.transaction.usdcToken ? { usdcToken: route.transaction.usdcToken } : {}),
          ...(route.transaction.sellAmount === undefined ? {} : { sellAmount: route.transaction.sellAmount.toString(10) }),
          ...(route.transaction.minBuyAmount === undefined ? {} : { minBuyAmount: route.transaction.minBuyAmount.toString(10) }),
        },
      };
    }
    const legs = route.legs.map((leg) => ({
      source: leg.source === 'LP' ? 0 : 1,
      liquidity: leg.liquidity,
      stockAmount: leg.fillAmount,
      minUsdcOut: leg.minUsdcOut,
      payload: this.encodeSwapLegPayload(leg),
    }));
    const plan = {
      requestId: request.requestId,
      taker: request.taker,
      recipient: request.recipient,
      stockToken: request.stockToken,
      usdcToken: request.usdcToken,
      settlement: this.config.settlementAddress,
      sellAmount: request.sellAmount,
      minBuyAmount: request.minBuyAmount,
      feeCapBps: Number(request.feeBps),
      deadline: request.deadline,
      decisionBlock: request.decisionBlock,
      decisionBlockHash: request.decisionBlockHash,
    } as const;
    const data = encodeFunctionData({ abi: RFQ_ROUTER_SWAP_EXECUTE_ABI, functionName: 'executeSwapRoute', args: [plan, legs] as never }) as Hex;
    return {
      kind: route.kind,
      source: route.source,
      routeId: route.routeId,
      stockAmount: route.stockAmount.toString(10),
      grossUsdc: route.grossUsdc.toString(10),
      guaranteedUsdc: route.guaranteedUsdc.toString(10),
      fee: route.fee.toString(10),
      gasEstimateUsdc: route.gasEstimateUsdc.toString(10),
      effectiveUsdc: route.effectiveUsdc.toString(10),
      expiry: route.expiry.toString(10),
      decisionBlock: request.decisionBlock.toString(10),
      decisionBlockHash: request.decisionBlockHash,
      allowanceTarget: this.config.routerAddress,
      settlementAllowanceTarget: this.config.settlementAddress,
      transaction: { to: this.config.routerAddress, data, value: '0' },
      legs: legs.map((leg) => ({ ...leg, stockAmount: leg.stockAmount.toString(10), minUsdcOut: leg.minUsdcOut.toString(10) })),
    };
  }

  private encodeSwapLegPayload(leg: import('../../../packages/base-core/src/index').SwapRouteLeg): Hex {
    if (leg.source === 'LP') {
      if (!leg.order || !leg.signature) throw new Error('LP_SIGNATURE_MISSING');
      return encodeAbiParameters([
        { type: 'tuple', components: [
          { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
          { name: 'stockToken', type: 'address' }, { name: 'usdcToken', type: 'address' },
          { name: 'stockAmount', type: 'uint256' }, { name: 'usdcAmount', type: 'uint256' },
          { name: 'fillMode', type: 'uint8' }, { name: 'expiry', type: 'uint256' },
          { name: 'salt', type: 'uint256' }, { name: 'feeCapBps', type: 'uint16' },
          { name: 'allowedTaker', type: 'address' }, { name: 'rfqId', type: 'bytes32' },
        ] },
        { type: 'bytes' },
      ], [{
        maker: leg.order.maker, signer: leg.order.signer, stockToken: leg.order.stockToken, usdcToken: leg.order.usdcToken,
        stockAmount: leg.order.stockAmount, usdcAmount: leg.order.usdcAmount, fillMode: leg.order.fillMode,
        expiry: leg.order.expiry, salt: leg.order.salt, feeCapBps: leg.order.feeCapBps,
        allowedTaker: leg.order.allowedTaker, rfqId: leg.order.rfqId,
      }, leg.signature]);
    }
    return encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [leg.quoteId, leg.usdcOut, leg.fillAmount, leg.expiry],
    );
  }

  async createLiquidation(raw: unknown, auth: BaseAuthContext): Promise<Readonly<Record<string, unknown>>> {
    this.requireLiquidationsEnabled();
    const input = parseLiquidationRequest(raw);
    const now = this.clock.nowSeconds();
    if (input.deadline <= now) throw new Error('RFQ_EXPIRED');
    const liquidation = await this.repository.createLiquidation({
      id: input.rfqId,
      opportunityKey: input.opportunityKey,
      rfqId: input.rfqId,
      poster: auth.identity,
      borrower: input.borrower,
      debtAsset: input.debtAsset,
      collateralAsset: input.collateralAsset,
      marketId: input.marketId,
      repayAssets: input.repayAssets.toString(10),
      minCollateralOut: input.minCollateralOut.toString(10),
      deadline: input.deadline.toString(10),
      createdAt: now.toString(10),
      status: 'open',
    });
    await this.attemptRank(liquidation.id);
    const updated = await this.repository.getLiquidation(liquidation.id);
    if (!updated) throw new Error('RFQ_NOT_FOUND');
    return publicLiquidation(updated);
  }

  async listLiquidations(): Promise<readonly Readonly<Record<string, unknown>>[]> {
    this.requireLiquidationsEnabled();
    return (await this.repository.listLiquidations()).map(publicLiquidation);
  }

  async getLiquidation(id: string): Promise<Readonly<Record<string, unknown>>> {
    this.requireLiquidationsEnabled();
    const liquidation = await this.repository.getLiquidation(id);
    if (!liquidation) throw new Error('RFQ_NOT_FOUND');
    return publicLiquidation(liquidation);
  }

  async placeBid(raw: unknown, auth: BaseAuthContext): Promise<Readonly<Record<string, unknown>>> {
    this.requireLiquidationsEnabled();
    const input = parseBidRequest(raw);
    const liquidation = await this.repository.getLiquidation(input.rfqId);
    if (!liquidation) throw new Error('RFQ_NOT_FOUND');
    if (liquidation.status !== 'open') throw new Error('RFQ_NOT_OPEN');
    requireIdentity(auth, input.order.maker, true);
    const now = this.clock.nowSeconds();
    const rankInput = await this.snapshot.getForRfq(liquidation, now);
    validateBidAgainstSnapshot(input, rankInput, liquidation, now, this.config.feeBps);
    const domain = domainFor(this.config);
    const orderHash = hashLiquidationFundingOrder(input.order, domain);
    const state = await this.signatures.getState(orderHash, input.order.maker);
    if (state.cancelled) throw new Error('ORDER_CANCELLED');
    const repayAssets = BigInt(liquidation.repayAssets);
    if (
      state.filled >= input.order.maxRepayAssets
      || state.filled + repayAssets > input.order.maxRepayAssets
      || state.filled + input.remainingCapacity > input.order.maxRepayAssets
      || input.remainingCapacity < repayAssets
    ) throw new Error('ORDER_CAPACITY');
    if (input.order.signer !== input.order.maker && !(await this.signatures.isDelegatedSigner(input.order.maker, input.order.signer))) throw new Error('SIGNER_NOT_DELEGATED');
    const signatureResult = await this.signatures.verifyOrder(input.order, input.signature, domain);
    if (!signatureResult.valid) throw new Error(signatureResult.reason ?? 'SIGNATURE_INVALID');
    const bid: StoredBid = {
      orderHash,
      rfqId: liquidation.rfqId,
      maker: input.order.maker,
      order: orderToStored(input.order),
      signature: input.signature,
      remainingCapacity: input.remainingCapacity.toString(10),
      minCollateralOut: input.minCollateralOut.toString(10),
      adapter: input.adapter,
      timestamp: now.toString(10),
      standing: input.order.rfqId === `0x${'00'.repeat(32)}`,
    };
    await this.repository.insertBid(bid);
    await this.attemptRank(liquidation.id);
    const updated = await this.repository.getLiquidation(liquidation.id);
    if (!updated) throw new Error('RFQ_NOT_FOUND');
    if (updated.status !== 'open' && updated.winner?.orderHash !== orderHash) throw new Error('RFQ_NOT_OPEN');
    return publicLiquidation(updated);
  }

  async standingBid(raw: unknown, auth: BaseAuthContext): Promise<Readonly<Record<string, unknown>>> {
    this.requireLiquidationsEnabled();
    const input = parseStandingBidRequest(raw);
    if (input.action === 'revoke') {
      if (!input.orderHash) throw new Error('ORDER_HASH_REQUIRED');
      const revoked = await this.repository.revokeStandingBid(auth.identity, input.orderHash);
      if (!revoked) throw new Error('STANDING_BID_NOT_FOUND');
      return { action: 'revoke', orderHash: input.orderHash, status: 'revoked' };
    }
    if (!input.bid) throw new Error('BID_REQUIRED');
    requireIdentity(auth, input.bid.order.maker, true);
    if (input.bid.rfqId !== `0x${'00'.repeat(32)}` || input.bid.order.rfqId !== `0x${'00'.repeat(32)}`) throw new Error('STANDING_RFQ_INVALID');
    const now = this.clock.nowSeconds();
    if (input.bid.order.expiry <= now) throw new Error('ORDER_EXPIRED');
    if (input.bid.order.fillMode !== 1) throw new Error('STANDING_FILL_MODE_INVALID');
    if (input.bid.order.maxRepayAssets === 0n || input.bid.remainingCapacity === 0n || input.bid.remainingCapacity > input.bid.order.maxRepayAssets) throw new Error('ORDER_CAPACITY');
    if (BigInt(input.bid.order.feeLimitBps) < this.config.feeBps) throw new Error('FEE_LIMIT');
    const domain = domainFor(this.config);
    const orderHash = hashLiquidationFundingOrder(input.bid.order, domain);
    const state = await this.signatures.getState(orderHash, input.bid.order.maker);
    if (state.cancelled) throw new Error('ORDER_CANCELLED');
    if (state.filled >= input.bid.order.maxRepayAssets || state.filled + input.bid.remainingCapacity > input.bid.order.maxRepayAssets) throw new Error('ORDER_CAPACITY');
    if (input.bid.order.signer !== input.bid.order.maker && !(await this.signatures.isDelegatedSigner(input.bid.order.maker, input.bid.order.signer))) throw new Error('SIGNER_NOT_DELEGATED');
    const signatureResult = await this.signatures.verifyOrder(input.bid.order, input.bid.signature, domain);
    if (!signatureResult.valid) throw new Error(signatureResult.reason ?? 'SIGNATURE_INVALID');
    const bid: StoredBid = {
      orderHash,
      rfqId: input.bid.rfqId,
      maker: input.bid.order.maker,
      order: orderToStored(input.bid.order),
      signature: input.bid.signature,
      remainingCapacity: input.bid.remainingCapacity.toString(10),
      minCollateralOut: input.bid.minCollateralOut.toString(10),
      adapter: input.bid.adapter,
      timestamp: this.clock.nowSeconds().toString(10),
      standing: true,
    };
    await this.repository.registerStandingBid(bid);
    return standingPublic(bid);
  }

  async standingBidsMe(auth: BaseAuthContext): Promise<readonly Readonly<Record<string, unknown>>[]> {
    this.requireLiquidationsEnabled();
    return (await this.repository.listStandingBids(auth.identity)).map(standingPublic);
  }

  async route(id: string, auth: BaseAuthContext): Promise<BaseRouteResponse> {
    this.requireLiquidationsEnabled();
    const liquidation = await this.repository.getLiquidation(id);
    if (!liquidation?.route || !liquidation.winner || liquidation.winner.identity !== auth.identity) throw new Error('UNAUTHORIZED');
    return routeResponse(liquidation.route);
  }

  async tick(): Promise<void> {
    if (this.config.liquidationEnabled === false) return;
    const now = this.clock.nowSeconds();
    for (const liquidation of await this.repository.listOpenLiquidations()) {
      if (BigInt(liquidation.deadline) <= now) {
        if (await this.repository.expireIfOpen(liquidation.id)) {
          const participants = (await this.repository.listBids(liquidation.id)).map((bid) => bid.maker);
          this.notifications.publish({
            type: 'rfq_expired',
            audience: uniqueAddresses([liquidation.poster, ...participants]),
            payload: { rfqId: liquidation.rfqId },
          });
        }
      } else {
        await this.attemptRank(liquidation.id);
      }
    }
  }

  private async attemptRank(id: string): Promise<void> {
    const liquidation = await this.repository.getLiquidation(id);
    if (!liquidation || liquidation.status !== 'open') return;
    const now = this.clock.nowSeconds();
    if (BigInt(liquidation.deadline) <= now) {
      await this.repository.expireIfOpen(id);
      return;
    }
    try {
      const base = await this.snapshot.getForRfq(liquidation, now);
      const bids = await this.listCandidateBids(liquidation, base);
      const input: LiquidationRankInput = {
        ...base,
        now,
        feeBps: this.config.feeBps,
        rfq: {
          ...base.rfq,
          rfqId: liquidation.rfqId,
          debtAsset: liquidation.debtAsset,
          collateralAsset: liquidation.collateralAsset,
          repayAssets: BigInt(liquidation.repayAssets),
          minCollateralOut: BigInt(liquidation.minCollateralOut),
          deadline: BigInt(liquidation.deadline),
          marketId: liquidation.marketId,
        },
        bids: bids.map((bid) => storedBidToDomain(bid)),
      };
      const result = rankLiquidation(input);
      if (result.status !== 'WINNER' || !result.route) {
        await this.repository.recordFailure(id, result.reason ?? 'NO_ELIGIBLE_BID');
        this.notifications.publish({
          type: 'rank_failed',
          audience: uniqueAddresses([liquidation.poster, ...bids.map((bid) => bid.maker)]),
          payload: { rfqId: liquidation.rfqId, reason: result.reason ?? 'NO_ELIGIBLE_BID' },
        });
        return;
      }
      const facilityQuotes = input.facilityQuotes;
      const source = await this.assembleRoute(liquidation, result.route, bids, facilityQuotes);
      const finalized = await this.repository.finalizeIfOpen(id, source, result.publicView.bidCount ?? 0);
      if (finalized) {
        this.notifications.publish({
          type: 'route_ready',
          audience: [source.winner],
          payload: { rfqId: source.rfqId, payloadHash: source.payloadHash, decisionBlock: source.decisionBlock },
        });
      }
    } catch (error) {
      const reason = stableFailureCode(error);
      await this.repository.recordFailure(id, reason);
      const bids = await this.repository.listBids(id);
      this.notifications.publish({
        type: 'rank_failed',
        audience: uniqueAddresses([liquidation.poster, ...bids.map((bid) => bid.maker)]),
        payload: { rfqId: liquidation.rfqId, reason },
      });
    }
  }

  private requireLiquidationsEnabled(): void {
    // Undefined preserves the compatibility behavior of hand-built test
    // configs; loadBaseApiConfig and defaultTestConfig provide explicit values.
    if (this.config.liquidationEnabled === false) throw new Error('LIQUIDATION_DISABLED');
  }

  private async listCandidateBids(liquidation: StoredLiquidation, base: LiquidationRankInput): Promise<readonly StoredBid[]> {
    const directBids = await this.repository.listBids(liquidation.id);
    const listAllStandingBids = this.repository.listAllStandingBids;
    if (!listAllStandingBids) return directBids;

    const directHashes = new Set(directBids.map((bid) => bid.orderHash.toLowerCase()));
    const domain = domainFor(this.config);
    const standingBids: StoredBid[] = [];
    for (const bid of await listAllStandingBids.call(this.repository)) {
      if (directHashes.has(bid.orderHash.toLowerCase())) continue;
      const order = storedToOrder(bid.order);
      if (order.debtAsset !== liquidation.debtAsset || order.collateralAsset !== liquidation.collateralAsset) continue;
      if (order.rfqId !== `0x${'00'.repeat(32)}` && order.rfqId !== liquidation.rfqId) continue;
      if (order.marketId !== `0x${'00'.repeat(32)}` && order.marketId !== liquidation.marketId) continue;
      if (order.venue !== `0x${'00'.repeat(20)}` && order.venue.toLowerCase() !== base.adapterSlot.toLowerCase()) continue;
      if (bid.adapter.toLowerCase() !== base.adapterSlot.toLowerCase()) continue;
      const expectedHash = hashLiquidationFundingOrder(order, domain);
      if (expectedHash.toLowerCase() !== bid.orderHash.toLowerCase()) continue;
      const state = await this.signatures.getState(bid.orderHash, order.maker);
      if (state.cancelled || state.filled >= order.maxRepayAssets) continue;
      if (order.signer !== order.maker && !(await this.signatures.isDelegatedSigner(order.maker, order.signer))) continue;
      const remaining = order.maxRepayAssets - state.filled;
      const available = BigInt(bid.remainingCapacity) < remaining ? BigInt(bid.remainingCapacity) : remaining;
      if (available <= 0n) continue;
      const verification = await this.signatures.verifyOrder(order, bid.signature, domain);
      if (!verification.valid) continue;
      standingBids.push({ ...bid, remainingCapacity: available.toString(10) });
    }
    return [...directBids, ...standingBids];
  }

  private async assembleRoute(
    liquidation: StoredLiquidation,
    route: RankedLiquidationRoute,
    bids: readonly StoredBid[],
    facilityQuotes: readonly FacilityLiquidationQuote[],
  ): Promise<StoredRoute> {
    let settlementOrFacility = this.config.settlementAddress;
    let fundingPayload: Hex;
    const winningBid = bids.find((bid) => bid.orderHash === route.orderHash);
    if (route.source === 'LP') {
      if (!winningBid) throw new Error('WINNER_RECORD_MISSING');
      const order = storedToOrder(winningBid.order);
      fundingPayload = encodeAbiParameters([
        {
          type: 'tuple',
          components: [
            { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
            { name: 'debtAsset', type: 'address' }, { name: 'collateralAsset', type: 'address' },
            { name: 'maxRepayAssets', type: 'uint256' }, { name: 'minCollateralOut', type: 'uint256' },
            { name: 'fillMode', type: 'uint8' }, { name: 'expiry', type: 'uint256' },
            { name: 'salt', type: 'uint256' }, { name: 'feeLimitBps', type: 'uint16' },
            { name: 'rfqId', type: 'bytes32' }, { name: 'venue', type: 'address' }, { name: 'marketId', type: 'bytes32' },
          ],
        },
        { type: 'bytes' },
      ], [{
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
        marketId: order.marketId,
      }, winningBid.signature]);
    } else {
      const quote = facilityQuotes.find((candidate) => facilityQuoteHash(candidate.quoteId, candidate.facility) === route.orderHash);
      if (!quote) throw new Error('WINNER_RECORD_MISSING');
      settlementOrFacility = quote.facility;
      fundingPayload = encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'address' }],
        [quote.quoteId, liquidation.marketId, liquidation.debtAsset, liquidation.collateralAsset],
      );
    }
    const plan = {
      rfqId: liquidation.rfqId,
      winner: route.winner,
      recipient: route.recipient,
      borrower: liquidation.borrower,
      deadline: BigInt(liquidation.deadline),
      source: route.source === 'LP' ? 0 : 1,
      settlementOrFacility,
      liquidationAdapter: route.adapter,
      repayAssets: route.repayAssets,
      minCollateralOutRfq: route.rfqMinCollateralOut,
      minCollateralOutFunder: route.funderMinCollateralOut,
      decisionBlock: route.decisionBlock,
      decisionBlockHash: route.decisionBlockHash,
      fundingPayload,
    } as const;
    const data = encodeFunctionData({ abi: RFQ_ROUTER_EXECUTE_ABI, functionName: 'executeLiquidationRoute', args: [plan] as never }) as Hex;
    return {
      rfqId: liquidation.rfqId,
      chainId: this.config.chainId,
      to: this.config.routerAddress,
      data,
      value: '0',
      payloadHash: keccak256(data),
      winner: route.winner,
      recipient: route.recipient,
      source: route.source,
      orderHash: route.orderHash,
      decisionBlock: route.decisionBlock.toString(10),
      decisionBlockHash: route.decisionBlockHash,
      deadline: liquidation.deadline,
      debtAsset: liquidation.debtAsset,
      collateralAsset: liquidation.collateralAsset,
      repayAssets: route.repayAssets.toString(10),
      minCollateralOutRfq: route.rfqMinCollateralOut.toString(10),
      minCollateralOutFunder: route.funderMinCollateralOut.toString(10),
    };
  }
}

function validateBidAgainstSnapshot(input: BidRequestInput, rankInput: LiquidationRankInput, liquidation: StoredLiquidation, now: bigint, feeBps: bigint): void {
  if (input.rfqId !== liquidation.rfqId) throw new Error('RFQ_MISMATCH');
  if (input.order.debtAsset !== liquidation.debtAsset || input.order.collateralAsset !== liquidation.collateralAsset) throw new Error('ASSET_MISMATCH');
  if (input.order.expiry <= now) throw new Error('ORDER_EXPIRED');
  if (input.order.maxRepayAssets < BigInt(liquidation.repayAssets) || input.remainingCapacity < BigInt(liquidation.repayAssets)) throw new Error('ORDER_CAPACITY');
  if (input.adapter !== rankInput.adapterSlot) throw new Error('VENUE_MISMATCH');
  if (BigInt(input.order.feeLimitBps) < feeBps) throw new Error('FEE_LIMIT');
  if (input.order.rfqId !== `0x${'00'.repeat(32)}` && input.order.rfqId !== liquidation.rfqId) throw new Error('RFQ_MISMATCH');
  if (input.order.venue !== `0x${'00'.repeat(20)}` && input.order.venue !== rankInput.adapterSlot) throw new Error('VENUE_MISMATCH');
  if (input.order.marketId !== `0x${'00'.repeat(32)}` && input.order.marketId !== liquidation.marketId) throw new Error('MARKET_MISMATCH');
}

function storedBidToDomain(bid: StoredBid) {
  const order = storedToOrder(bid.order);
  return {
    source: 'LP' as const,
    maker: bid.maker,
    order,
    remainingCapacity: BigInt(bid.remainingCapacity),
    timestamp: BigInt(bid.timestamp),
    minCollateralOut: BigInt(bid.minCollateralOut),
    adapter: bid.adapter,
  };
}

function publicLiquidation(liquidation: StoredLiquidation): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    id: liquidation.id,
    rfqId: liquidation.rfqId,
    debtAsset: liquidation.debtAsset,
    collateralAsset: liquidation.collateralAsset,
    marketId: liquidation.marketId,
    repayAssets: liquidation.repayAssets,
    minCollateralOut: liquidation.minCollateralOut,
    deadline: liquidation.deadline,
    status: liquidation.status,
  };
  if (liquidation.bidCount !== undefined) result.bidCount = liquidation.bidCount;
  if (liquidation.winner) result.winner = { identity: liquidation.winner.identity, source: liquidation.winner.source };
  return result;
}

function standingPublic(bid: StoredBid): Readonly<Record<string, unknown>> {
  return {
    orderHash: bid.orderHash,
    maker: bid.maker,
    order: { ...bid.order },
    signature: bid.signature,
    remainingCapacity: bid.remainingCapacity,
    minCollateralOut: bid.minCollateralOut,
    adapter: bid.adapter,
    timestamp: bid.timestamp,
  };
}

function routeResponse(route: StoredRoute): BaseRouteResponse {
  if (
    !route.debtAsset
    || !route.collateralAsset
    || route.repayAssets === undefined
    || route.minCollateralOutRfq === undefined
    || route.minCollateralOutFunder === undefined
  ) throw new Error('ROUTE_METADATA_UNAVAILABLE');
  return {
    chainId: String(route.chainId),
    to: route.to,
    target: route.to,
    data: route.data,
    value: route.value,
    payloadHash: route.payloadHash,
    decisionBlock: route.decisionBlock,
    decisionBlockHash: route.decisionBlockHash,
    deadline: route.deadline,
    debtAsset: route.debtAsset,
    collateralAsset: route.collateralAsset,
    repayAssets: route.repayAssets,
    minCollateralOutRfq: route.minCollateralOutRfq,
    minCollateralOutFunder: route.minCollateralOutFunder,
    winner: route.winner,
    source: route.source,
    recipient: route.recipient,
  };
}

function requireIdentity(auth: BaseAuthContext, identity: Address, allowInternal: boolean): void {
  if (auth.identity === identity || (allowInternal && auth.scopes.includes('internal'))) return;
  throw new Error('UNAUTHORIZED');
}

function uniqueAddresses(values: readonly Address[]): Address[] {
  return [...new Set(values.map((value) => value.toLowerCase()))] as Address[];
}

function stableFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)) return error.message;
  return 'RANK_FAILED';
}

function stablePreflightFailure(error: unknown): string {
  if (error instanceof Error && /^PREFLIGHT_[A-Z0-9_:-]+$/.test(error.message)) return error.message;
  return 'PREFLIGHT_FAILED';
}

function validHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value);
}

function validAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
}

function hasProviderMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (['decisionBlock', 'decisionBlockHash', 'simulationBlock', 'simulationBlockHash', 'preflight'].some((key) => key in record)) return true;
  const external = Array.isArray(record.externalQuotes) ? record.externalQuotes : [];
  return external.some((quote) => {
    if (!quote || typeof quote !== 'object') return false;
    const transaction = (quote as Record<string, unknown>).transaction;
    return Boolean(transaction && typeof transaction === 'object' && 'simulation' in (transaction as Record<string, unknown>));
  });
}

function swapRouteKey(route: RankedSwapRoute): string {
  return route.kind === 'EXTERNAL'
    ? `EXTERNAL:${route.source}:${route.routeId.toLowerCase()}`
    : `INTERNAL:${route.legs.map((leg) => leg.quoteId.toLowerCase()).join(',')}`;
}

function sameSwapRoute(left: RankedSwapRoute, right: RankedSwapRoute): boolean {
  return swapRouteKey(left) === swapRouteKey(right);
}

function uniqueSwapRoutes(routes: readonly (RankedSwapRoute | undefined)[]): RankedSwapRoute[] {
  const seen = new Set<string>();
  const output: RankedSwapRoute[] = [];
  for (const route of routes) {
    if (!route) continue;
    const key = swapRouteKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(route);
  }
  return output;
}

function findEquivalentSwapRoute(result: ReturnType<typeof rankSwapQuotes>, target: RankedSwapRoute): RankedSwapRoute | undefined {
  return uniqueSwapRoutes([result.recommended, ...result.alternatives, ...result.external]).find((route) => sameSwapRoute(route, target));
}

export { publicLiquidation, routeResponse };
