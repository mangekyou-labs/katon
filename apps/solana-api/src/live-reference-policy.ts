import {
  evaluateReferencePolicy,
  type ReferenceObservation,
  type ReferencePolicyProvider,
  type ReferencePolicySnapshot,
} from './reference-policy';

const PYTH_ENDPOINT = 'https://pyth-lazer.dourolabs.app/v1/latest_price';
const PYTH_SYMBOL = 'Equity.US.AAPL/USD';
const REFERENCE_SYMBOL = 'AAPL/USD';
const REFERENCE_MAX_AGE_MS = 15_000;
const MAX_U32 = 0xffff_ffff;
const MARKET_SESSIONS = ['regular', 'preMarket', 'postMarket', 'overNight', 'closed'] as const;
type MarketSession = typeof MARKET_SESSIONS[number];

export interface ReferenceObservationSource {
  readonly id: string;
  read(): Promise<ReferenceObservation>;
}

export interface PythProAaplSourceOptions {
  readonly apiKey: string;
  readonly channel?: 'real_time' | 'fixed_rate@1ms' | 'fixed_rate@50ms' | 'fixed_rate@200ms' | 'fixed_rate@1000ms';
  readonly fetcher?: typeof fetch;
}

interface PythPriceFeed {
  readonly priceFeedId?: unknown;
  readonly price?: unknown;
  readonly exponent?: unknown;
  readonly feedUpdateTimestamp?: unknown;
  readonly marketSession?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMarketSession(value: unknown): value is MarketSession {
  return typeof value === 'string' && (MARKET_SESSIONS as readonly string[]).includes(value);
}

function decimalInteger(value: unknown, label: string, signed = false): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Pyth ${label} is missing`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Pyth ${label} is malformed`);
  const text = String(value);
  if (!(signed ? /^-?[0-9]+$/ : /^[0-9]+$/).test(text)) throw new Error(`Pyth ${label} is malformed`);
  return BigInt(text);
}

function decimalExponent(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < -18 || number > 18) throw new Error('Pyth exponent is malformed');
  return number;
}

function priceToAtomic(price: bigint, exponent: number, decimals = 6): string {
  if (price <= 0n) throw new Error('Pyth price must be positive');
  const shift = exponent + decimals;
  if (shift >= 0) return (price * 10n ** BigInt(shift)).toString();
  const divisor = 10n ** BigInt(-shift);
  const quotient = price / divisor;
  const remainder = price % divisor;
  const rounded = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  if (rounded <= 0n) throw new Error('Pyth price rounds below the supported precision');
  return rounded.toString();
}

function timestampUsToMs(value: unknown): number {
  const timestampUs = decimalInteger(value, 'feedUpdateTimestamp');
  const timestampMs = timestampUs / 1_000n;
  if (timestampMs <= 0n || timestampMs > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Pyth feedUpdateTimestamp is out of range');
  return Number(timestampMs);
}

function parseFeedId(value: unknown): string {
  const feedId = decimalInteger(value, 'priceFeedId');
  if (feedId < 0n || feedId > BigInt(MAX_U32)) throw new Error('Pyth priceFeedId is outside the u32 range');
  return feedId.toString();
}

/** Parses the single response to an exact AAPL symbol request and uses feed update time, not response time. */
export function parsePythProAaplPayload(payload: unknown): ReferenceObservation {
  const envelope = Array.isArray(payload)
    ? payload.length === 1 ? payload[0] : undefined
    : payload;
  if (!isRecord(envelope)) throw new Error('Pyth response envelope is malformed');
  const parsed = isRecord(envelope.parsed) ? envelope.parsed : envelope;
  const feeds = parsed.priceFeeds;
  if (!Array.isArray(feeds) || feeds.length !== 1 || !isRecord(feeds[0])) throw new Error('Pyth response must contain exactly one price feed');
  const feed = feeds[0] as PythPriceFeed;
  // The REST request is made by the full Pyth symbol, so the returned feed ID
  // is checked for a valid u32 shape while the request pins the instrument.
  parseFeedId(feed.priceFeedId);
  if (!isMarketSession(feed.marketSession)) {
    throw new Error('Pyth marketSession is missing or malformed');
  }
  const priceAtomic = priceToAtomic(decimalInteger(feed.price, 'price', true), decimalExponent(feed.exponent));
  const observedAtMs = timestampUsToMs(feed.feedUpdateTimestamp);
  return {
    provider: `pyth-pro:${PYTH_SYMBOL}`,
    symbol: PYTH_SYMBOL,
    licensedPrimary: true,
    priceAtomic,
    observedAtMs,
    sessionOpen: feed.marketSession === 'regular',
    marketSession: feed.marketSession,
    corporateActionPending: false,
  };
}

export class PythProAaplSource implements ReferenceObservationSource {
  readonly id = 'pyth-primary';
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: PythProAaplSourceOptions) {
    if (!options.apiKey.trim()) throw new Error('PYTH_PRO_API_KEY is required');
    this.fetcher = options.fetcher ?? fetch;
  }

  async read(): Promise<ReferenceObservation> {
    const response = await this.fetcher(PYTH_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        symbols: [PYTH_SYMBOL],
        properties: ['price', 'exponent', 'feedUpdateTimestamp', 'marketSession'],
        formats: ['leUnsigned'],
        parsed: true,
        channel: this.options.channel ?? 'fixed_rate@1000ms',
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Pyth Pro request failed (${response.status})`);
    return parsePythProAaplPayload(await response.json() as unknown);
  }
}

export interface HttpIndependentCrossCheckSourceOptions {
  readonly url: string;
  readonly provider: string;
  readonly bearerToken?: string;
  readonly fetcher?: typeof fetch;
}

/**
 * Adapter contract for an independently licensed provider. Its server-side endpoint must return:
 * { symbol: "AAPL/USD", priceAtomic: "<USD at 6 decimals>", observedAtMs, marketSession,
 *   corporateActionPending }. Provider identity is configured out of band and cannot be supplied
 * by the endpoint response. A second Pyth feed is rejected as a cross-check.
 */
export class HttpIndependentCrossCheckSource implements ReferenceObservationSource {
  readonly id = 'cross-check';
  private readonly fetcher: typeof fetch;
  private readonly url: URL;

  constructor(private readonly options: HttpIndependentCrossCheckSourceOptions) {
    if (!options.provider.trim() || /pyth/i.test(options.provider)) throw new Error('cross-check provider must identify a non-Pyth source');
    this.url = new URL(options.url);
    if (!['https:', 'http:'].includes(this.url.protocol)) throw new Error('cross-check URL must use HTTP or HTTPS');
    if (this.url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)) {
      throw new Error('cross-check URL must use HTTPS outside localhost');
    }
    if (this.url.username || this.url.password) throw new Error('cross-check URL must not contain credentials');
    this.fetcher = options.fetcher ?? fetch;
  }

  async read(): Promise<ReferenceObservation> {
    const response = await this.fetcher(this.url, {
      headers: {
        accept: 'application/json',
        ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}),
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`independent cross-check request failed (${response.status})`);
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.symbol !== REFERENCE_SYMBOL) throw new Error('independent cross-check symbol must be AAPL/USD');
    if (typeof body.priceAtomic !== 'string' || !/^[1-9][0-9]*$/.test(body.priceAtomic)) throw new Error('independent cross-check priceAtomic is malformed');
    if (!Number.isSafeInteger(body.observedAtMs) || (body.observedAtMs as number) <= 0) throw new Error('independent cross-check observedAtMs is malformed');
    if (!isMarketSession(body.marketSession)) {
      throw new Error('independent cross-check marketSession is malformed');
    }
    if (typeof body.corporateActionPending !== 'boolean') throw new Error('independent cross-check corporateActionPending is malformed');
    return {
      provider: this.options.provider,
      symbol: REFERENCE_SYMBOL,
      licensedPrimary: false,
      priceAtomic: body.priceAtomic,
      observedAtMs: body.observedAtMs as number,
      sessionOpen: body.marketSession === 'regular',
      marketSession: body.marketSession,
      corporateActionPending: body.corporateActionPending,
    };
  }
}

interface ObservationState {
  readonly observation?: ReferenceObservation;
  readonly error?: string;
}

export class LiveReferencePolicyProvider implements ReferencePolicyProvider {
  private readonly states = new Map<string, ObservationState>();
  private refreshSequence = 0;

  constructor(
    private readonly sources: readonly ReferenceObservationSource[],
    private readonly configurationErrors: readonly string[] = [],
  ) {}

  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    const outcomes = await Promise.all(this.sources.map(async (source) => {
      try {
        return { source, observation: await source.read() } as const;
      } catch (error) {
        return { source, error: error instanceof Error ? error.message : 'source request failed' } as const;
      }
    }));
    if (sequence !== this.refreshSequence) return;
    for (const outcome of outcomes) {
      this.states.set(outcome.source.id, 'observation' in outcome
        ? { observation: outcome.observation }
        : { observation: this.states.get(outcome.source.id)?.observation, error: outcome.error });
    }
  }

  snapshot(nowMs: number): ReferencePolicySnapshot {
    const primary = this.states.get('pyth-primary')?.observation;
    const crossCheck = this.states.get('cross-check')?.observation;
    const observations = [primary, crossCheck].filter((item): item is ReferenceObservation => item !== undefined);
    const evaluated = evaluateReferencePolicy(observations, nowMs, REFERENCE_MAX_AGE_MS);
    const refreshErrors = this.sources.flatMap((source) => {
      const error = this.states.get(source.id)?.error;
      return error ? [`${source.id}: ${error}`] : [];
    });
    const reasons = [...this.configurationErrors, ...refreshErrors];
    const reason = [evaluated.reason, ...reasons].filter((item): item is string => Boolean(item)).join('; ') || undefined;
    // A failed current refresh cannot borrow a still-young prior sample and report ready.
    if (reasons.length > 0 && evaluated.status === 'ready') {
      return { ...evaluated, status: 'unavailable', reason: reason ?? 'reference source refresh failed' };
    }
    if (reasons.length > 0 && evaluated.status === 'unavailable') return { ...evaluated, reason };
    return { ...evaluated, ...(reason ? { reason } : {}), ...(primary ? { pyth: primary } : {}) };
  }
}

export function createLiveReferencePolicyProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): LiveReferencePolicyProvider {
  const sources: ReferenceObservationSource[] = [];
  const configurationErrors: string[] = [];
  const apiKey = env.PYTH_PRO_API_KEY?.trim();
  const channel = env.PYTH_PRO_CHANNEL?.trim();
  const supportedChannels = ['real_time', 'fixed_rate@1ms', 'fixed_rate@50ms', 'fixed_rate@200ms', 'fixed_rate@1000ms'] as const;
  if (channel && !(supportedChannels as readonly string[]).includes(channel)) {
    configurationErrors.push('PYTH_PRO_CHANNEL must be a supported Pyth Pro channel');
  }
  if (apiKey) {
    try {
      sources.push(new PythProAaplSource({
        apiKey,
        ...(channel && (supportedChannels as readonly string[]).includes(channel) ? { channel: channel as typeof supportedChannels[number] } : {}),
        fetcher,
      }));
    } catch (error) {
      configurationErrors.push(error instanceof Error ? error.message : 'Pyth Pro AAPL feed configuration is invalid');
    }
  } else {
    configurationErrors.push('Pyth Pro AAPL/USD is not configured; set PYTH_PRO_API_KEY');
  }

  const crossCheckUrl = env.KATON_REFERENCE_CROSSCHECK_URL?.trim();
  const crossCheckProvider = env.KATON_REFERENCE_CROSSCHECK_PROVIDER?.trim();
  if (crossCheckUrl && crossCheckProvider) {
    try {
      sources.push(new HttpIndependentCrossCheckSource({
        url: crossCheckUrl,
        provider: crossCheckProvider,
        bearerToken: env.KATON_REFERENCE_CROSSCHECK_BEARER?.trim() || undefined,
        fetcher,
      }));
    } catch (error) {
      configurationErrors.push(error instanceof Error ? error.message : 'independent cross-check configuration is invalid');
    }
  } else {
    configurationErrors.push('independent non-Pyth AAPL/USD cross-check is not configured');
  }
  return new LiveReferencePolicyProvider(sources, configurationErrors);
}
