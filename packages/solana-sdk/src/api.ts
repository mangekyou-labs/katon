import type { AssetRegistryEntry, EligibilityResult, QuoteCandidate, SanitizedAuditRow, TradeReceipt } from '@katon/solana-core';

export type AssetCapability = 'executable' | 'informational' | 'unavailable';

export interface ReferencePolicyView {
  readonly status: 'ready' | 'market_closed' | 'stale' | 'conflicting' | 'corporate_action_pending' | 'unavailable';
  readonly checkedAtMs: number;
  readonly primary?: { readonly provider: string; readonly priceAtomic: string; readonly observedAtMs: number };
}

export interface AssetView extends AssetRegistryEntry {
  readonly balanceAtomic: string;
  readonly eligibility: EligibilityResult;
  /** Discovery projection; absent on older servers — treat enabled xStocks as executable. */
  readonly capability?: AssetCapability;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly referencePolicy?: ReferencePolicyView;
}

export type QuoteSprintState =
  | 'validating'
  | 'collecting'
  | 'winner_ready'
  | 'authorized'
  | 'action_required'
  | 'ineligible'
  | 'capability_unavailable'
  | 'no_liquidity'
  | 'expired';

export interface QuoteSprintRequest {
  readonly wallet: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
}

export interface QuoteSprint {
  readonly id: string;
  readonly request: QuoteSprintRequest;
  readonly eligibility: EligibilityResult;
  readonly state: QuoteSprintState;
  readonly createdAtMs: number;
  readonly collectionDeadlineMs: number;
  readonly winner?: QuoteCandidate;
  readonly audit: readonly SanitizedAuditRow[];
  /** Bound review package hash when the server projects one. */
  readonly reviewHash?: string;
  readonly failureMessage?: string;
}

export interface AuthorizeQuoteSprintRequest {
  readonly wallet: string;
  readonly reviewHash: string;
  readonly signedTransactionBase64: string;
}

export interface CreateExecutionAttemptRequest {
  readonly quoteSprintId: string;
  readonly idempotencyKey: string;
}

export interface ExecutionAttemptResult {
  readonly attemptId: string;
  readonly quoteSprintId: string;
  readonly status: 'provisional' | 'final' | 'reconciling' | 'failed' | 'rejected' | 'expired' | 'not_landed';
  readonly signature?: string;
  readonly receipt?: TradeReceipt;
}

export interface SolanaApiClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  /** Browser origin for Seller proof binding; defaults to window.location.origin in a browser. */
  readonly origin?: string;
}

export interface SellerWalletSession {
  readonly token: string;
  readonly wallet: string;
  readonly cluster: string;
  readonly expiresAtMs: number;
}

interface SellerChallengeResponse {
  readonly challengeId: string;
  readonly message: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export class SolanaApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly origin?: string;
  private sellerSession?: SellerWalletSession;

  constructor(options: SolanaApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetcher = (options.fetcher ?? fetch).bind(globalThis);
    this.origin = options.origin ?? (typeof window === 'undefined' ? undefined : window.location.origin);
  }

  setSellerSession(session: SellerWalletSession): void { this.sellerSession = session; }
  clearSellerSession(): void { this.sellerSession = undefined; }
  activeSellerSession(): SellerWalletSession | undefined { return this.sellerSession; }

  async authenticateSeller(
    wallet: string,
    cluster: string,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  ): Promise<SellerWalletSession> {
    const headers = { ...(this.origin ? { 'x-katon-origin': this.origin } : {}), 'x-katon-cluster': cluster };
    const challenge = await this.request<SellerChallengeResponse>('/v1/seller-sessions/challenge', {
      method: 'POST', headers, body: JSON.stringify({ publicKey: wallet }),
    });
    const signature = await signMessage(new TextEncoder().encode(challenge.message));
    const session = await this.request<{ readonly token: string; readonly expiresAtMs: number; readonly wallet: string; readonly cluster: string }>('/v1/seller-sessions', {
      method: 'POST', headers,
      body: JSON.stringify({ publicKey: wallet, challengeId: challenge.challengeId, signature: base64Url(signature) }),
    });
    const result = { token: session.token, expiresAtMs: session.expiresAtMs, wallet: session.wallet, cluster: session.cluster };
    this.sellerSession = result;
    return result;
  }

  async listAssets(wallet: string, outputMint: string): Promise<readonly AssetView[]> {
    return this.requestSeller<readonly AssetView[]>(wallet, `/v1/assets?wallet=${encodeURIComponent(wallet)}&outputMint=${encodeURIComponent(outputMint)}`);
  }

  async createQuoteSprint(request: QuoteSprintRequest): Promise<QuoteSprint> {
    return this.requestSeller<QuoteSprint>(request.wallet, '/v1/quote-sprints', { method: 'POST', body: JSON.stringify(request) });
  }

  async getQuoteSprint(id: string): Promise<QuoteSprint> {
    return this.requestSeller<QuoteSprint>(undefined, `/v1/quote-sprints/${encodeURIComponent(id)}`);
  }

  async reviewQuoteSprint(id: string, wallet: string): Promise<QuoteSprint> {
    return this.requestSeller<QuoteSprint>(wallet, `/v1/quote-sprints/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ wallet }) });
  }

  async authorizeQuoteSprint(id: string, body: AuthorizeQuoteSprintRequest): Promise<QuoteSprint> {
    return this.requestSeller<QuoteSprint>(body.wallet, `/v1/quote-sprints/${encodeURIComponent(id)}/authorize`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async createExecutionAttempt(body: CreateExecutionAttemptRequest): Promise<ExecutionAttemptResult> {
    return this.requestSeller<ExecutionAttemptResult>(undefined, '/v1/execution-attempts', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'idempotency-key': body.idempotencyKey },
    });
  }

  async listTrades(wallet: string): Promise<readonly TradeReceipt[]> {
    return this.requestSeller<readonly TradeReceipt[]>(wallet, `/v1/trades?wallet=${encodeURIComponent(wallet)}`);
  }

  eventsUrl(id: string): string {
    return `${this.baseUrl}/v1/quote-sprints/${encodeURIComponent(id)}/events`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === 'object' && body !== null && 'message' in body ? String(body.message) : `request failed (${response.status})`;
      throw new Error(message);
    }
    return body as T;
  }

  private async requestSeller<T>(wallet: string | undefined, path: string, init?: RequestInit): Promise<T> {
    const session = this.sellerSession;
    if (!session || Date.now() >= session.expiresAtMs) {
      this.clearSellerSession();
      throw new Error('Seller wallet session is missing or expired; prove wallet control again');
    }
    if (wallet && session.wallet !== wallet) throw new Error('Seller wallet session does not match the connected wallet');
    return this.request<T>(path, {
      ...init,
      headers: {
        authorization: `Bearer ${session.token}`,
        ...(this.origin ? { 'x-katon-origin': this.origin } : {}),
        'x-katon-cluster': session.cluster,
        ...(init?.headers ?? {}),
      },
    });
  }
}
