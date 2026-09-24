import { base64FromBytes, bytesFromBase64 } from './transactions';

export type WalletConnectionState = 'disconnected' | 'connecting' | 'locked' | 'connected' | 'wrong-cluster' | 'rejected';

export interface WalletAccount {
  readonly address: string;
  readonly publicKey?: Uint8Array;
  readonly chains: readonly string[];
}

export interface WalletStandardLike {
  readonly name: string;
  readonly icon?: string;
  readonly accounts: readonly WalletAccount[];
  readonly connect: () => Promise<void>;
  readonly disconnect?: () => Promise<void>;
  readonly signAndSendTransaction?: (transaction: Uint8Array, options?: { readonly minContextSlot?: number }) => Promise<Uint8Array>;
  readonly signTransaction?: (transaction: Uint8Array) => Promise<Uint8Array>;
}

export interface WalletAdapter {
  readonly state: WalletConnectionState;
  readonly wallet?: WalletStandardLike;
  readonly account?: WalletAccount;
  connect(): Promise<WalletConnectionState>;
  disconnect(): Promise<void>;
  sign(transactionBase64: string): Promise<string>;
}

export function walletStateFromError(error: unknown): WalletConnectionState {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('reject') || message.includes('denied')) return 'rejected';
  if (message.includes('lock')) return 'locked';
  if (message.includes('cluster') || message.includes('network')) return 'wrong-cluster';
  return 'disconnected';
}

/**
 * Thin Wallet Standard bridge. It only asks the wallet to sign the bytes it
 * receives; transaction construction, mutation, and submission stay outside
 * this adapter. A wallet exposing signAndSendTransaction but not
 * signTransaction is intentionally rejected for the RFQ review flow because
 * the signed bytes must be hash-checked by the API before forwarding.
 */
export class WalletStandardAdapter implements WalletAdapter {
  private connectionState: WalletConnectionState = 'disconnected';
  private selectedAccount?: WalletAccount;
  private readonly expectedChain: string;

  constructor(public readonly wallet: WalletStandardLike, expectedChain = 'solana:localnet') {
    this.expectedChain = expectedChain;
  }

  get state(): WalletConnectionState { return this.connectionState; }
  get account(): WalletAccount | undefined { return this.selectedAccount; }

  async connect(): Promise<WalletConnectionState> {
    this.connectionState = 'connecting';
    try {
      await this.wallet.connect();
      const account = this.wallet.accounts[0];
      if (!account) {
        this.connectionState = 'locked';
        return this.connectionState;
      }
      if (!account.chains.includes(this.expectedChain)) {
        this.connectionState = 'wrong-cluster';
        return this.connectionState;
      }
      this.selectedAccount = account;
      this.connectionState = 'connected';
      return this.connectionState;
    } catch (error) {
      this.connectionState = walletStateFromError(error);
      return this.connectionState;
    }
  }

  async disconnect(): Promise<void> {
    if (this.wallet.disconnect) await this.wallet.disconnect();
    this.selectedAccount = undefined;
    this.connectionState = 'disconnected';
  }

  async sign(transactionBase64: string): Promise<string> {
    if (this.connectionState !== 'connected' || !this.selectedAccount) {
      throw new Error(`wallet is not connected to ${this.expectedChain}`);
    }
    if (!this.wallet.signTransaction) throw new Error('wallet does not expose signTransaction; managed signing is not supported');
    try {
      const signed = await this.wallet.signTransaction(bytesFromBase64(transactionBase64));
      return base64FromBytes(signed);
    } catch (error) {
      this.connectionState = walletStateFromError(error);
      throw error;
    }
  }
}
