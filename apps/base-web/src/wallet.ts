import {
  createWalletClient,
  custom,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  appendBuilderCodeSuffix,
  encodeBuilderCodeSuffix,
  hasBuilderCodeSuffix,
} from '../../../packages/base-core/src/builder-code';

export interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged' | 'chainChanged', listener: (...args: readonly unknown[]) => void): unknown;
  removeListener?(event: 'accountsChanged' | 'chainChanged', listener: (...args: readonly unknown[]) => void): unknown;
}

export type BaseWalletStatus = 'disconnected' | 'connecting' | 'connected' | 'wrong-chain';

export interface BaseWalletState {
  readonly status: BaseWalletStatus;
  readonly address?: Address;
  readonly chainId?: number;
  readonly expectedChainId: number;
  readonly error?: string;
}

export interface UnsignedBaseTransaction {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
}

export interface BaseReceipt {
  readonly transactionHash: Hex;
  readonly status: 'success' | 'reverted';
  readonly blockNumber?: bigint;
}

export interface WaitForReceiptOptions {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ERC20_ALLOWANCE_ABI = [{
  type: 'function',
  name: 'allowance',
  stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;
const ERC20_BALANCE_ABI = [{
  type: 'function',
  name: 'balanceOf',
  stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

/** Build-time fallback for the ERC-8021 Builder Code. */
const BUILDER_CODE_ENV_KEY = 'VITE_KATON_BASE_BUILDER_CODE';

export class BaseWallet {
  readonly walletClient: ReturnType<typeof createWalletClient>;
  private state: BaseWalletState;
  private readonly stateListeners = new Set<(state: BaseWalletState) => void>();
  private readonly provider: Eip1193Provider;
  private readonly attributionSuffix?: Hex;
  private readonly handleAccountsChanged = (): void => { void this.refresh(); };
  private readonly handleChainChanged = (): void => { void this.refresh(); };

  constructor(
    provider: Eip1193Provider,
    readonly expectedChainId = 84532,
    readonly rpcUrl = 'https://sepolia.base.org',
    builderCode?: string,
  ) {
    this.provider = provider;
    this.state = { status: 'disconnected', expectedChainId };
    // The suffix is validated once, at construction, so a malformed builder code
    // can never silently strip attribution from a funded transaction.
    if (builderCode !== undefined && builderCode !== '') {
      this.attributionSuffix = encodeBuilderCodeSuffix([builderCode]);
    }
    const chain = defineChain({
      id: expectedChainId,
      name: expectedChainId === 8453 ? 'Base Mainnet' : 'Base Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    this.walletClient = createWalletClient({ chain, transport: custom(provider as never) });
    provider.on?.('accountsChanged', this.handleAccountsChanged);
    provider.on?.('chainChanged', this.handleChainChanged);
  }

  /** The exact ERC-8021 suffix appended to every contract call, when configured. */
  getAttributionSuffix(): Hex | undefined {
    return this.attributionSuffix;
  }

  /**
   * Apply ERC-8021 attribution at the single shared transaction boundary so
   * facility calls, venue calls, approvals, and router submissions are all
   * attributed. Value-only transfers stay untouched, and calldata that already
   * carries the marker fails closed instead of double-counting.
   */
  attributeCalldata(data: Hex): Hex {
    if (!this.attributionSuffix) return data;
    if (hasBuilderCodeSuffix(data)) throw new Error('BUILDER_CODE_DUPLICATE_SUFFIX');
    return appendBuilderCodeSuffix(data, this.attributionSuffix);
  }

  getState(): BaseWalletState {
    return this.state;
  }

  subscribe(listener: (state: BaseWalletState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  async connect(): Promise<BaseWalletState> {
    this.setState({ status: 'connecting', expectedChainId: this.expectedChainId });
    try {
      const accounts = await this.provider.request({ method: 'eth_requestAccounts' });
      const address = firstAddress(accounts);
      if (!address) throw new Error('WALLET_ACCOUNT_REQUIRED');
      const chainId = await readChainId(this.provider);
      const next = chainState(address, chainId, this.expectedChainId);
      this.setState(next);
      return next;
    } catch (error) {
      const next: BaseWalletState = {
        status: 'disconnected',
        expectedChainId: this.expectedChainId,
        error: errorCode(error),
      };
      this.setState(next);
      throw error;
    }
  }

  async refresh(): Promise<BaseWalletState> {
    try {
      const accounts = await this.provider.request({ method: 'eth_accounts' });
      const address = firstAddress(accounts, false);
      if (!address) {
        const next = { status: 'disconnected' as const, expectedChainId: this.expectedChainId };
        this.setState(next);
        return next;
      }
      const chainId = await readChainId(this.provider);
      const next = chainState(address, chainId, this.expectedChainId);
      this.setState(next);
      return next;
    } catch (error) {
      const next: BaseWalletState = {
        status: 'disconnected',
        expectedChainId: this.expectedChainId,
        error: errorCode(error),
      };
      this.setState(next);
      return next;
    }
  }

  async switchToBase(): Promise<BaseWalletState> {
    try {
      await this.provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${this.expectedChainId.toString(16)}` }],
      });
    } catch (error) {
      if (!isUnknownChain(error)) throw error;
      await this.provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: `0x${this.expectedChainId.toString(16)}`,
          chainName: this.expectedChainId === 8453 ? 'Base Mainnet' : 'Base Sepolia',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [this.rpcUrl],
          blockExplorerUrls: [this.expectedChainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org'],
        }],
      });
    }
    return this.refresh();
  }

  assertWritable(): Address {
    if (this.state.status === 'wrong-chain') throw new Error('WRONG_CHAIN');
    if (this.state.status !== 'connected' || !this.state.address) throw new Error('WALLET_NOT_CONNECTED');
    return this.state.address;
  }

  /** Simulate exactly the calldata that would be sent, attribution included. */
  async simulate(transaction: UnsignedBaseTransaction): Promise<unknown> {
    return this.simulateCall({ ...transaction, data: this.attributeCalldata(transaction.data) });
  }

  async sendTransaction(transaction: UnsignedBaseTransaction): Promise<Hex> {
    const from = this.assertWritable();
    const data = this.attributeCalldata(transaction.data);
    await this.simulateCall({ ...transaction, data });
    const result = await this.provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from,
        to: transaction.to,
        data,
        value: toHex(transaction.value ?? 0n),
      }],
    });
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error('TX_HASH_INVALID');
    return result as Hex;
  }

  async readAllowance(token: Address, spender: Address, owner = this.assertWritable()): Promise<bigint> {
    if (token === ZERO_ADDRESS || spender === ZERO_ADDRESS) throw new Error('ALLOWANCE_ADDRESS_INVALID');
    const data = encodeFunctionData({
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    const raw = await this.provider.request({
      method: 'eth_call',
      params: [{ to: token, data }, 'latest'],
    });
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('ALLOWANCE_READ_FAILED');
    try {
      const decoded = decodeFunctionResult({ abi: ERC20_ALLOWANCE_ABI, functionName: 'allowance', data: raw as Hex });
      if (typeof decoded !== 'bigint') throw new Error('ALLOWANCE_READ_FAILED');
      return decoded;
    } catch {
      throw new Error('ALLOWANCE_READ_FAILED');
    }
  }

  async readTokenBalance(token: Address, owner = this.assertWritable()): Promise<bigint> {
    const data = encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [owner] });
    const raw = await this.provider.request({ method: 'eth_call', params: [{ to: token, data }, 'latest'] });
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('TOKEN_BALANCE_READ_FAILED');
    try {
      const decoded = decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', data: raw as Hex });
      if (typeof decoded !== 'bigint') throw new Error('TOKEN_BALANCE_READ_FAILED');
      return decoded;
    } catch {
      throw new Error('TOKEN_BALANCE_READ_FAILED');
    }
  }

  /** Set an exact allowance, returning undefined when it is already exact. */
  async approveExactAllowance(token: Address, spender: Address, amount: bigint): Promise<Hex | undefined> {
    if (amount <= 0n) throw new Error('ALLOWANCE_AMOUNT_INVALID');
    const current = await this.readAllowance(token, spender);
    if (current === amount) return undefined;
    return this.writeContract({ address: token, abi: [{
      type: 'function', name: 'approve', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }],
    }] as const, functionName: 'approve', args: [spender, amount] });
  }

  /**
   * Verify the server-pinned decision block before sending route calldata. A
   * changed block hash or an age beyond the router policy forces a re-quote.
   */
  async assertRouteFresh(input: { readonly decisionBlock: string | bigint; readonly decisionBlockHash: Hex; readonly maxAge?: bigint }): Promise<void> {
    const decisionBlock = typeof input.decisionBlock === 'bigint' ? input.decisionBlock : BigInt(input.decisionBlock);
    const maxAge = input.maxAge ?? 3n;
    if (decisionBlock <= 0n || maxAge < 1n || !/^0x[0-9a-fA-F]{64}$/.test(input.decisionBlockHash) || /^0x0{64}$/i.test(input.decisionBlockHash)) throw new Error('SWAP_QUOTE_STALE');
    let latest: bigint;
    try {
      const raw = await this.provider.request({ method: 'eth_blockNumber' });
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('SWAP_QUOTE_STALE');
      latest = BigInt(raw);
      const latestBlock = await this.provider.request({ method: 'eth_getBlockByNumber', params: [`0x${latest.toString(16)}`, false] });
      const latestHash = blockHash(latestBlock);
      if (!latestHash || latest < decisionBlock || latest - decisionBlock > maxAge) throw new Error('SWAP_QUOTE_STALE');
      const decisionBlockRaw = await this.provider.request({ method: 'eth_getBlockByNumber', params: [`0x${decisionBlock.toString(16)}`, false] });
      if (blockHash(decisionBlockRaw)?.toLowerCase() !== input.decisionBlockHash.toLowerCase()) throw new Error('SWAP_QUOTE_STALE');
    } catch (error) {
      if (error instanceof Error && error.message === 'SWAP_QUOTE_STALE') throw error;
      throw new Error('SWAP_QUOTE_STALE');
    }
  }

  async sendRouteOnly(transaction: UnsignedBaseTransaction, freshness?: { readonly decisionBlock: string | bigint; readonly decisionBlockHash: Hex; readonly maxAge?: bigint }): Promise<Hex> {
    if (freshness) await this.assertRouteFresh(freshness);
    return this.sendTransaction(transaction);
  }

  async signMessage(message: string): Promise<Hex> {
    const address = this.assertWritable();
    const result = await this.provider.request({ method: 'personal_sign', params: [message, address] });
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) throw new Error('SIGNATURE_INVALID');
    return result as Hex;
  }

  async signTypedDataV4(typedDataJson: string): Promise<Hex> {
    const address = this.assertWritable();
    const result = await this.provider.request({ method: 'eth_signTypedData_v4', params: [address, typedDataJson] });
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) throw new Error('SIGNATURE_INVALID');
    return result as Hex;
  }

  async writeContract<TAbi extends Abi>(input: {
    readonly address: Address;
    readonly abi: TAbi;
    readonly functionName: string;
    readonly args?: readonly unknown[];
    readonly value?: bigint;
  }): Promise<Hex> {
    const data = encodeFunctionData({
      abi: input.abi,
      functionName: input.functionName as never,
      args: (input.args ?? []) as never,
    } as never);
    return this.sendTransaction({ to: input.address, data, ...(input.value !== undefined ? { value: input.value } : {}) });
  }

  async waitForReceipt(hash: Hex, options: WaitForReceiptOptions = {}): Promise<BaseReceipt> {
    const intervalMs = options.intervalMs ?? 750;
    const maxAttempts = options.maxAttempts ?? 80;
    if (intervalMs < 0 || maxAttempts <= 0 || !Number.isSafeInteger(maxAttempts)) throw new Error('RECEIPT_OPTIONS_INVALID');
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const raw = await this.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (raw && typeof raw === 'object') {
        const record = raw as Record<string, unknown>;
        const status = record.status === '0x1' || record.status === '0x01' ? 'success' : record.status === '0x0' || record.status === '0x00' ? 'reverted' : undefined;
        if (status) {
          const blockNumber = typeof record.blockNumber === 'string' && /^0x[0-9a-fA-F]+$/.test(record.blockNumber) ? BigInt(record.blockNumber) : undefined;
          return { transactionHash: hash, status, ...(blockNumber !== undefined ? { blockNumber } : {}) };
        }
      }
      if (attempt + 1 < maxAttempts && intervalMs > 0) await delay(intervalMs);
    }
    throw new Error(`RECEIPT_TIMEOUT:${hash}`);
  }

  dispose(): void {
    this.provider.removeListener?.('accountsChanged', this.handleAccountsChanged);
    this.provider.removeListener?.('chainChanged', this.handleChainChanged);
    this.stateListeners.clear();
  }

  private async simulateCall(transaction: UnsignedBaseTransaction): Promise<unknown> {
    const from = this.assertWritable();
    return this.provider.request({
      method: 'eth_call',
      params: [{
        from,
        to: transaction.to,
        data: transaction.data,
        value: toHex(transaction.value ?? 0n),
      }, 'latest'],
    });
  }

  private setState(next: BaseWalletState): void {
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}

export function createBrowserWallet(chainId = 84532, rpcUrl = 'https://sepolia.base.org'): BaseWallet | null {
  if (typeof window === 'undefined') return null;
  const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!provider) return null;
  return new BaseWallet(provider, chainId, rpcUrl, readBuilderCode());
}

/**
 * Resolve the ERC-8021 Builder Code from the injected runtime config first and
 * the build-time Vite value second. An unset code simply disables attribution;
 * a malformed one throws from the wallet constructor.
 */
function readBuilderCode(): string | undefined {
  const globalConfig = typeof window === 'undefined'
    ? undefined
    : (window as Window & { __KATON_BASE_CONFIG__?: unknown }).__KATON_BASE_CONFIG__;
  const injected = builderCodeFrom(globalConfig);
  if (injected !== undefined) return injected;
  const envConfig = (import.meta as ImportMeta & { readonly env?: Readonly<Record<string, string | undefined>> }).env?.[BUILDER_CODE_ENV_KEY];
  return envConfig === undefined || envConfig === '' ? undefined : envConfig;
}

function builderCodeFrom(config: unknown): string | undefined {
  if (config === undefined || config === null) return undefined;
  let parsed: unknown = config;
  if (typeof config === 'string') {
    try { parsed = JSON.parse(config) as unknown; } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = (parsed as { builderCode?: unknown }).builderCode;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function chainState(address: Address, chainId: number, expectedChainId: number): BaseWalletState {
  return {
    status: chainId === expectedChainId ? 'connected' : 'wrong-chain',
    address,
    chainId,
    expectedChainId,
    ...(chainId === expectedChainId ? {} : { error: 'WRONG_CHAIN' }),
  };
}

function firstAddress(value: unknown, required = true): Address | undefined {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'string') {
    if (required) throw new Error('WALLET_ACCOUNT_REQUIRED');
    return undefined;
  }
  const candidate = value[0];
  if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) throw new Error('WALLET_ACCOUNT_INVALID');
  const address = candidate.toLowerCase() as Address;
  return address === ZERO_ADDRESS ? undefined : address;
}

async function readChainId(provider: Eip1193Provider): Promise<number> {
  const value = await provider.request({ method: 'eth_chainId' });
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error('CHAIN_ID_INVALID');
  const chainId = Number(BigInt(value));
  if (!Number.isSafeInteger(chainId) || chainId < 0) throw new Error('CHAIN_ID_INVALID');
  return chainId;
}

function toHex(value: bigint): Hex {
  if (value < 0n) throw new Error('TX_VALUE_INVALID');
  return `0x${value.toString(16)}` as Hex;
}

function isUnknownChain(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 4902;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code: unknown }).code);
  return 'WALLET_ERROR';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function blockHash(value: unknown): Hex | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const hash = (value as { hash?: unknown }).hash;
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash as Hex : undefined;
}
