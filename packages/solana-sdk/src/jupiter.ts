import { assertJupiterPayloadUnchanged } from '../../solana-core/src/venues';

export interface JupiterOrderClient {
  order(request: Record<string, string>): Promise<JupiterOrderResponse>;
  execute(requestId: string, signedTransactionBase64: string): Promise<{ readonly signature: string; readonly status: string }>;
}

export interface JupiterOrderResponse {
  readonly requestId: string;
  readonly router: string;
  readonly transaction: string;
  readonly outAmount: string;
  readonly routePlan?: readonly unknown[];
  readonly fees?: Readonly<Record<string, string>>;
  readonly expiresAt?: number;
}

/** Keeps Jupiter's returned transaction opaque, including JupiterZ managed signing. */
export class JupiterAdapter {
  constructor(private readonly client: JupiterOrderClient) {}

  async order(request: Record<string, string>): Promise<JupiterOrderResponse> {
    const response = await this.client.order(request);
    if (!response.transaction || !response.requestId || !response.outAmount) throw new Error('Jupiter order response is incomplete');
    return response;
  }

  async execute(order: JupiterOrderResponse, signedTransactionBase64: string): Promise<{ readonly signature: string; readonly status: string }> {
    assertJupiterPayloadUnchanged(order.transaction, signedTransactionBase64);
    return this.client.execute(order.requestId, signedTransactionBase64);
  }
}
