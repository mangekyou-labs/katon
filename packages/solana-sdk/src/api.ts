import type { AssetRegistryEntry, EligibilityResult, QuoteSession, QuoteSessionRequest, TradeReceipt } from '@katon/solana-core';

export interface AssetView extends AssetRegistryEntry {
  readonly balanceAtomic: string;
  readonly eligibility: EligibilityResult;
}

export interface SolanaApiClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
}

export class SolanaApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: SolanaApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  async listAssets(wallet: string, outputMint: string): Promise<readonly AssetView[]> {
    return this.request<readonly AssetView[]>(`/v1/assets?wallet=${encodeURIComponent(wallet)}&outputMint=${encodeURIComponent(outputMint)}`);
  }

  async createQuoteSession(request: QuoteSessionRequest): Promise<QuoteSession> {
    return this.request<QuoteSession>('/v1/quote-sessions', { method: 'POST', body: JSON.stringify(request) });
  }

  async getQuoteSession(id: string): Promise<QuoteSession> {
    return this.request<QuoteSession>(`/v1/quote-sessions/${encodeURIComponent(id)}`);
  }

  async reviewQuoteSession(id: string, wallet: string): Promise<QuoteSession> {
    return this.request<QuoteSession>(`/v1/quote-sessions/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ wallet }),
    });
  }

  async execute(id: string, wallet: string, signedTransactionBase64: string): Promise<TradeReceipt> {
    return this.request<TradeReceipt>(`/v1/quote-sessions/${encodeURIComponent(id)}/execute`, {
      method: 'POST',
      body: JSON.stringify({ wallet, signedTransactionBase64 }),
    });
  }

  async listTrades(wallet: string): Promise<readonly TradeReceipt[]> {
    return this.request<readonly TradeReceipt[]>(`/v1/trades?wallet=${encodeURIComponent(wallet)}`);
  }

  eventsUrl(id: string): string {
    return `${this.baseUrl}/v1/quote-sessions/${encodeURIComponent(id)}/events`;
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
}
