/**
 * Codama-compatible generated-client boundary. The concrete generated module
 * is pinned to the deployed IDL during release; keeping the addresses and
 * instruction names typed here prevents an accidental web3.js v1 dependency.
 */
export const SOLANA_RFQ_PROGRAM_ID = '59MVYbUATHzCgYtD7uio4RvCkZhdwrRh6c38ZefycwMX';

export interface SettlePrivateQuoteArgs {
  readonly quoteId: Uint8Array;
  readonly expiry: bigint;
  readonly stockAmount: bigint;
  readonly makerMinStockReceipt: bigint;
  readonly grossStableAmount: bigint;
  readonly sellerMinStableReceipt: bigint;
  readonly feeBps: number;
  readonly extensionFingerprint: Uint8Array;
}

export interface SolanaRfqClient {
  buildSettlePrivateQuote(args: SettlePrivateQuoteArgs): Promise<string>;
  buildCloseFillReceipt(quoteId: Uint8Array, maker: string): Promise<string>;
}
