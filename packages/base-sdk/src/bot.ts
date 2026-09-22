import type { SignedBidDto } from './index';
import { BaseLpClient, type BaseLpClientOptions } from './index';

export interface DryRunBotOptions extends BaseLpClientOptions {
  readonly signedBid: SignedBidDto;
  readonly logger?: (message: string, details?: Readonly<Record<string, string>>) => void;
}

/**
 * Minimal example bot: it accepts a bid signed elsewhere and posts only that
 * bid. It has no wallet, route, settlement, or transaction-signing surface.
 */
export async function runDryRunBot(options: DryRunBotOptions): Promise<unknown> {
  const logger = options.logger ?? ((message: string, details?: Readonly<Record<string, string>>) => console.log(message, details));
  logger('posting signed LP bid', { keyId: redact(options.keyId), rfqId: options.signedBid.rfqId });
  const client = new BaseLpClient(options);
  const result = await client.placeBid(options.signedBid);
  logger('signed LP bid accepted');
  return result;
}

export function redact(value: string): string {
  if (value.length <= 4) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
