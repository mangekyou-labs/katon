import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { decodeBase58, encodeBase58 } from '@katon/solana-core';
import type { AssetRegistryEntry, MintAccountSnapshot, QuoteCandidate, VerifiedSourceBalance } from '@katon/solana-core';
import { localnetTestAsset, type LocalnetSettlementFixture } from './localnet-settlement';
import type { AssetProvider, QuoteSimulationProvider } from './service';
import type { QuoteSource, SourceBalanceProvider } from './sources';
import { transactionHash } from '@katon/solana-sdk';
import { validateMakerSettlement } from './maker-settlement';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RFQ = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SYSTEM = '11111111111111111111111111111111';
const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export interface LocalnetFixtureConfig extends LocalnetSettlementFixture {
  readonly rpcUrl: string;
  readonly chain: 'solana:localnet';
  readonly sellerPubkey: string;
  readonly makerKeypairPath: string;
  readonly stableMints: readonly [string, string];
  readonly feeRecipient: string;
  readonly sellerStockAccount: string;
  readonly makerStockAccount: string;
  readonly stockIssuerAuthority: string;
  readonly assetRegistry: string;
  readonly governance: string;
  readonly makerRegistry: string;
  readonly governanceVault: string;
  readonly programLoaded: true;
  readonly testAssets: true;
  readonly asset: AssetRegistryEntry;
}

function readKey(data: Buffer, offset: number): string {
  return encodeBase58(data.subarray(offset, offset + 32));
}

function digest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function anchorDiscriminator(name: string): Buffer { return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8); }
function associatedToken(owner: string, mint: string, tokenProgram: string): string {
  return PublicKey.findProgramAddressSync([
    new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer(),
  ], new PublicKey(ASSOCIATED_TOKEN))[0].toBase58();
}

export function loadLocalnetFixtureConfig(path = process.env.KATON_LOCALNET_CONFIG ?? '.local/solana-seller-localnet.json'): LocalnetFixtureConfig {
  const config = JSON.parse(readFileSync(resolve(path), 'utf8')) as Partial<LocalnetFixtureConfig>;
  const required = ['rpcUrl', 'chain', 'programId', 'stockMint', 'stockTokenProgram', 'stockDecimals', 'stockExtensionFingerprint', 'sellerStockAccount', 'makerStockAccount', 'makerPublicKey', 'makerStableAccounts', 'sellerStableAccounts', 'feeStableAccounts', 'feeRecipient', 'stableTokenProgram', 'assetRegistry', 'makerRegistry', 'governance', 'governanceVault', 'feeBps', 'sellerPubkey', 'makerKeypairPath', 'stableMints', 'stockIssuerAuthority', 'asset', 'programLoaded', 'testAssets'] as const;
  if (required.some((key) => config[key] === undefined) || config.chain !== 'solana:localnet' || config.programLoaded !== true || config.testAssets !== true) {
    throw new Error('localnet settlement fixture is missing a deployed program, governed policy, or test asset identity');
  }
  if (config.programId !== RFQ || !config.asset || config.asset.mint !== config.stockMint || config.feeBps !== 10) {
    throw new Error('localnet settlement fixture does not match the test policy');
  }
  return config as LocalnetFixtureConfig;
}

interface RpcAccount { readonly owner: string; readonly executable: boolean; readonly data: Buffer; }

export class LocalnetRpcClient {
  constructor(readonly fixture: LocalnetFixtureConfig, private readonly fetcher: typeof fetch = fetch) {}

  async call<T>(method: string, params: unknown[] = [], fetcher: typeof fetch = this.fetcher): Promise<T> {
    const response = await fetcher(this.fixture.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.json() as { result?: T; error?: { message?: string } };
    if (!response.ok || body.error || body.result === undefined) throw new Error(body.error?.message ?? `localnet RPC ${method} failed`);
    return body.result;
  }

  async account(address: string): Promise<RpcAccount> {
    const result = await this.call<{ value: null | { owner: string; executable: boolean; data: [string, string] } }>(
      'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }],
    );
    if (!result.value) throw new Error(`required localnet account ${address} is missing`);
    return { owner: result.value.owner, executable: result.value.executable, data: Buffer.from(result.value.data[0], 'base64') };
  }

  async tokenBalance(address: string, mint: string, tokenProgram: string, expectedOwner?: string): Promise<string> {
    const account = await this.account(address);
    // This fixture deliberately supports only classic SPL token accounts. Any
    // other account size can indicate an extension-bearing or otherwise
    // unsupported account layout and must fail closed before Seller signing.
    if (account.owner !== tokenProgram || account.data.length !== 165 || readKey(account.data, 0) !== mint
      || (expectedOwner !== undefined && readKey(account.data, 32) !== expectedOwner)
      || account.data[108] !== 1 || account.data.readUInt32LE(72) !== 0 || account.data[109] !== 0
      || account.data.readBigUInt64LE(121) !== 0n || account.data.readUInt32LE(129) !== 0) {
      throw new Error(`token account ${address} has unsupported owner, mint, delegate, native, close-authority, or state`);
    }
    return account.data.readBigUInt64LE(64).toString();
  }

  async latestBlockhash(): Promise<string> {
    const result = await this.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (!result.value.blockhash) throw new Error('localnet did not return a recent blockhash');
    return result.value.blockhash;
  }

  async alignTestClock(nowMs: number): Promise<void> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('localnet test clock timestamp is invalid');
    // Surfpool can start with a virtual Clock that trails the host wall clock.
    // The RFQ program enforces its signed issued/expiry window against Clock,
    // so align the offline test bank just ahead of quote creation before the
    // transaction receives its fresh blockhash. The lead allows for the RPC
    // round trip while preserving nearly the full quote lifetime.
    await this.call('surfnet_timeTravel', [{ absoluteTimestamp: nowMs + 2_000 }]);
  }

  async simulate(candidate: QuoteCandidate, sigVerify: boolean): Promise<{ ok: boolean; unitsConsumed?: number; errorCode?: string }> {
    if (!candidate.transactionBase64) return { ok: false, errorCode: 'transaction_unavailable' };
    const result = await this.call<{ value: { err: unknown; unitsConsumed?: number; logs?: string[] } }>(
      'simulateTransaction', [candidate.transactionBase64, {
        encoding: 'base64', sigVerify, replaceRecentBlockhash: false, commitment: 'confirmed',
      }],
    );
    const value = result.value;
    return value.err
      ? { ok: false, errorCode: typeof value.err === 'string' ? value.err : JSON.stringify(value.err), ...(value.unitsConsumed === undefined ? {} : { unitsConsumed: value.unitsConsumed }) }
      : { ok: true, ...(value.unitsConsumed === undefined ? {} : { unitsConsumed: value.unitsConsumed }) };
  }

  async assertProgramReady(): Promise<void> {
    const program = await this.account(this.fixture.programId);
    if (!program.executable) throw new Error('solana_rfq is not executable on this localnet');
  }

  async assertGovernedFixture(outputMint?: string): Promise<void> {
    await this.assertProgramReady();
    const [governance, makers, assetRegistry, stockMint] = await Promise.all([
      this.account(this.fixture.governance), this.account(this.fixture.makerRegistry),
      this.account(this.fixture.assetRegistry), this.account(this.fixture.stockMint),
    ]);
    if ([governance, makers, assetRegistry].some((account) => account.owner !== this.fixture.programId)) {
      throw new Error('localnet policy account owner does not match solana_rfq');
    }
    if (!governance.data.subarray(0, 8).equals(anchorDiscriminator('GovernanceConfig'))
      || !makers.data.subarray(0, 8).equals(anchorDiscriminator('MakerRegistry'))
      || !assetRegistry.data.subarray(0, 8).equals(anchorDiscriminator('AssetRegistry'))) {
      throw new Error('localnet policy account discriminator is invalid');
    }
    const gov = governance.data;
    if (readKey(gov, 8) !== this.fixture.governanceVault || gov[72] !== 0
      || gov.readUInt16LE(89) !== this.fixture.feeBps || gov.readUInt16LE(91) < this.fixture.feeBps) {
      throw new Error('localnet governance is paused or its signed fee policy has drifted');
    }
    const makerCount = makers.data.readUInt32LE(8);
    const makerStart = 12;
    const allowlisted = Array.from({ length: makerCount }, (_, index) => readKey(makers.data, makerStart + index * 32));
    const makerPausedOffset = makerStart + makerCount * 32;
    if (makers.data[makerPausedOffset] !== 0 || !allowlisted.includes(this.fixture.makerPublicKey)) {
      throw new Error('localnet Private Maker is paused or not governed');
    }
    const assetData = assetRegistry.data;
    const hookCountOffset = 364;
    if (readKey(assetData, 8) !== this.fixture.stockMint || readKey(assetData, 40) !== this.fixture.stockTokenProgram
      || readKey(assetData, 72) !== this.fixture.stableTokenProgram
      || readKey(assetData, 104) !== this.fixture.stableMints[0]
      || readKey(assetData, 136) !== this.fixture.stableMints[1]
      || assetData[168] !== 0 || !assetData.subarray(299, 331).equals(Buffer.from(this.fixture.stockExtensionFingerprint, 'hex'))) {
      throw new Error('localnet asset registry identity has drifted from the signed test policy');
    }
    const hookCount = assetData.readUInt32LE(hookCountOffset);
    const enabledOffset = hookCountOffset + 4 + hookCount * 67;
    if (readKey(assetData, 169) !== this.fixture.asset.expectedMetadataPointer
      || readKey(assetData, 201) !== this.fixture.stockIssuerAuthority
      || assetData[enabledOffset] !== 1 || assetData[enabledOffset + 1] !== 0) {
      throw new Error('localnet stock asset is disabled, paused, or its issuer metadata policy has drifted');
    }
    if (stockMint.owner !== this.fixture.stockTokenProgram || stockMint.data.length !== 82
      || stockMint.data[44] !== this.fixture.stockDecimals || stockMint.data[45] !== 1
      || stockMint.data.readUInt32LE(0) !== 1 || readKey(stockMint.data, 4) !== this.fixture.stockIssuerAuthority
      || stockMint.data.readUInt32LE(46) !== 0
      || digest(stockMint.data.subarray(0, 0)) !== this.fixture.stockExtensionFingerprint
      || digest(stockMint.data.subarray(4, 36)) !== this.fixture.asset.issuerAuthorityFingerprint) {
      throw new Error('localnet stock mint owner, decimals, authority, or extensions have drifted');
    }
    if (this.fixture.sellerStockAccount !== associatedToken(this.fixture.sellerPubkey, this.fixture.stockMint, this.fixture.stockTokenProgram)
      || this.fixture.makerStockAccount !== associatedToken(this.fixture.makerPublicKey, this.fixture.stockMint, this.fixture.stockTokenProgram)) {
      throw new Error('localnet stock accounts are not the governed Seller and Maker associated token accounts');
    }
    const sellerBalance = await this.tokenBalance(this.fixture.sellerStockAccount, this.fixture.stockMint, this.fixture.stockTokenProgram, this.fixture.sellerPubkey);
    if (sellerBalance === '0') throw new Error('Seller stock account has no spendable balance');
    if (outputMint) {
      if (!this.fixture.stableMints.includes(outputMint as typeof USDC)) throw new Error('stable output is not governed by local asset policy');
      const makerStable = this.fixture.makerStableAccounts[outputMint];
      const sellerStable = this.fixture.sellerStableAccounts[outputMint];
      const feeStable = this.fixture.feeStableAccounts[outputMint];
      if (!makerStable || !sellerStable || !feeStable) throw new Error('governed stablecoin account set is incomplete');
      if (makerStable !== associatedToken(this.fixture.makerPublicKey, outputMint, this.fixture.stableTokenProgram)
        || sellerStable !== associatedToken(this.fixture.sellerPubkey, outputMint, this.fixture.stableTokenProgram)
        || feeStable !== associatedToken(this.fixture.feeRecipient, outputMint, this.fixture.stableTokenProgram)) {
        throw new Error('localnet stablecoin accounts are not the governed Maker, Seller, and fee-recipient associated accounts');
      }
      await Promise.all([
        this.tokenBalance(this.fixture.makerStockAccount, this.fixture.stockMint, this.fixture.stockTokenProgram, this.fixture.makerPublicKey),
        this.tokenBalance(makerStable, outputMint, this.fixture.stableTokenProgram, this.fixture.makerPublicKey),
        this.tokenBalance(sellerStable, outputMint, this.fixture.stableTokenProgram, this.fixture.sellerPubkey),
        this.tokenBalance(feeStable, outputMint, this.fixture.stableTokenProgram, this.fixture.feeRecipient),
      ]);
      const stableMint = await this.account(outputMint);
      if (stableMint.owner !== this.fixture.stableTokenProgram || stableMint.data.length !== 82 || stableMint.data[44] !== 6
        || stableMint.data[45] !== 1 || stableMint.data.readUInt32LE(46) !== 0) {
        throw new Error('local native stablecoin mint does not match the Token program or six-decimal policy');
      }
    }
  }

  async verifySourceBalance(candidate: QuoteCandidate, checkedAtMs: number): Promise<VerifiedSourceBalance> {
    await this.assertGovernedFixture(candidate.outputMint);
    const account = this.fixture.makerStableAccounts[candidate.outputMint];
    if (!account) throw new Error('Maker has no governed stablecoin source account');
    const balanceAtomic = await this.tokenBalance(account, candidate.outputMint, this.fixture.stableTokenProgram, this.fixture.makerPublicKey);
    if (BigInt(balanceAtomic) < BigInt(candidate.grossOutputAtomic)) throw new Error('Maker stablecoin source liquidity is insufficient');
    return { sourceId: candidate.sourceId, outputMint: candidate.outputMint, balanceAtomic, checkedAtMs };
  }

  async submitSettlement(candidate: QuoteCandidate, signedTransactionBase64: string, fetcher: typeof fetch = this.fetcher) {
    if (candidate.sourceKind !== 'private-maker' || candidate.sourceId !== 'maker-sandbox-01') {
      throw new Error('only the governed Private Maker can submit local RFQ settlements');
    }
    await this.assertGovernedFixture(candidate.outputMint);
    const terms = {
      quoteId: candidate.quoteId,
      wallet: candidate.wallet,
      makerPublicKey: this.fixture.makerPublicKey,
      inputMint: candidate.inputMint,
      outputMint: candidate.outputMint,
      inputAmountAtomic: candidate.inputAmountAtomic,
      outputAmountAtomic: candidate.grossOutputAtomic,
      feeBps: this.fixture.feeBps,
      expiresAtMs: candidate.expiresAtMs,
      feeRecipient: this.fixture.feeRecipient,
      stockTokenProgram: this.fixture.stockTokenProgram,
      stableTokenProgram: this.fixture.stableTokenProgram,
      extensionFingerprint: this.fixture.stockExtensionFingerprint,
    };
    validateMakerSettlement(candidate.transactionBase64 ?? '', terms, Date.now());
    validateMakerSettlement(signedTransactionBase64, terms, Date.now());
    if (await transactionHash(signedTransactionBase64) !== await transactionHash(candidate.transactionBase64 ?? '')) {
      throw new Error('Seller signature changed the reviewed RFQ message');
    }
    const transaction = VersionedTransaction.deserialize(Buffer.from(signedTransactionBase64, 'base64'));
    const signatureBytes = transaction.signatures[0];
    if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) throw new Error('Seller signature is missing from the issued transaction');
    const signature = encodeBase58(signatureBytes);
    const outputMint = candidate.outputMint;
    const makerStable = this.fixture.makerStableAccounts[outputMint];
    const sellerStable = this.fixture.sellerStableAccounts[outputMint];
    const feeStable = this.fixture.feeStableAccounts[outputMint];
    if (!makerStable || !sellerStable || !feeStable) throw new Error('settlement account set is not governed');
    const tokenAccounts = [
      this.fixture.sellerStockAccount, this.fixture.makerStockAccount,
      makerStable, sellerStable, feeStable,
    ];
    const tokenMints = [this.fixture.stockMint, this.fixture.stockMint, outputMint, outputMint, outputMint];
    const tokenPrograms = [this.fixture.stockTokenProgram, this.fixture.stockTokenProgram,
      this.fixture.stableTokenProgram, this.fixture.stableTokenProgram, this.fixture.stableTokenProgram];
    const tokenOwners = [this.fixture.sellerPubkey, this.fixture.makerPublicKey, this.fixture.makerPublicKey, this.fixture.sellerPubkey, this.fixture.feeRecipient];
    const before = await Promise.all(tokenAccounts.map((account, index) => this.tokenBalance(account, tokenMints[index]!, tokenPrograms[index]!, tokenOwners[index]!)));
    const simulation = await this.call<{ value: { err: unknown } }>('simulateTransaction', [signedTransactionBase64, {
      encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed',
    }]);
    if (simulation.value.err) throw new Error(`signed RFQ preflight failed: ${JSON.stringify(simulation.value.err)}`);

    const submittedAtMs = Date.now();
    let sendError: unknown;
    let returnedSignature: unknown;
    try {
      returnedSignature = await this.call<string>('sendTransaction', [signedTransactionBase64, {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0,
      }], fetcher);
    } catch (error) { sendError = error; }
    if (returnedSignature !== undefined && returnedSignature !== signature) {
      throw new SubmissionUncertainError(signature, 'RPC returned a different signature; settlement is being reconciled');
    }
    const deadline = Date.now() + (sendError === undefined ? 30_000 : 5_000);
    let status: { confirmationStatus?: string; err?: unknown } | null = null;
    while (Date.now() < deadline) {
      try {
        const response = await this.call<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>(
          'getSignatureStatuses', [[signature], { searchTransactionHistory: true }],
        );
        status = response.value[0] ?? null;
        if (status?.err) throw new Error(`RFQ settlement failed on chain: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('RFQ settlement failed on chain:')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!status || (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized')) {
      throw new SubmissionUncertainError(signature, sendError instanceof Error
        ? `RPC submission outcome is unknown and will be reconciled: ${sendError.message}`
        : 'RPC submission was not observed before the confirmation deadline; it will be reconciled');
    }
    const transactionResult = await this.call<null | { slot: number; meta: { err: unknown } | null }>(
      'getTransaction', [signature, { commitment: status.confirmationStatus, maxSupportedTransactionVersion: 0 }],
    );
    if (!transactionResult || !transactionResult.meta || transactionResult.meta.err) {
      throw new SubmissionUncertainError(signature, 'confirmed transaction details are unavailable; settlement is being reconciled');
    }
    const after = await Promise.all(tokenAccounts.map((account, index) => this.tokenBalance(account, tokenMints[index]!, tokenPrograms[index]!, tokenOwners[index]!)));
    const input = BigInt(candidate.inputAmountAtomic);
    const gross = BigInt(candidate.grossOutputAtomic);
    const fee = gross * BigInt(this.fixture.feeBps) / 10_000n;
    const expected = [
      BigInt(before[0]!) - input, BigInt(before[1]!) + input,
      BigInt(before[2]!) - gross, BigInt(before[3]!) + gross - fee, BigInt(before[4]!) + fee,
    ];
    if (after.some((value, index) => BigInt(value) !== expected[index])) {
      throw new SubmissionUncertainError(signature, 'confirmed settlement token deltas do not match the signed quote; reconciliation is required');
    }
    const quoteIdBytes = Buffer.from(candidate.quoteId, 'hex');
    const makerKey = new PublicKey(this.fixture.makerPublicKey);
    const fillReceipt = PublicKey.findProgramAddressSync([Buffer.from('fill'), makerKey.toBuffer(), quoteIdBytes], new PublicKey(this.fixture.programId))[0];
    const receiptAccount = await this.account(fillReceipt.toBase58());
    if (receiptAccount.owner !== this.fixture.programId || !receiptAccount.data.subarray(0, 8).equals(anchorDiscriminator('FillReceipt'))
      || !receiptAccount.data.subarray(8, 40).equals(quoteIdBytes)
      || readKey(receiptAccount.data, 40) !== this.fixture.makerPublicKey
      || readKey(receiptAccount.data, 72) !== candidate.wallet
      || readKey(receiptAccount.data, 104) !== candidate.wallet
      || receiptAccount.data.readBigUInt64LE(144) !== gross
      || receiptAccount.data.readBigUInt64LE(152) !== fee) {
      throw new SubmissionUncertainError(signature, 'confirmed RFQ fill receipt does not match the quote; reconciliation is required');
    }
    const confirmedAtMs = Date.now();
    const finalized = status.confirmationStatus === 'finalized';
    return {
      signature, submittedAtMs, confirmedAtMs,
      ...(finalized ? { finalizedAtMs: confirmedAtMs } : {}),
      commitment: finalized ? 'finalized' as const : 'confirmed' as const,
      cluster: this.fixture.chain,
      slot: transactionResult.slot,
      stockMint: this.fixture.stockMint,
      stableMint: outputMint,
      stockTokenProgram: this.fixture.stockTokenProgram,
      stableTokenProgram: this.fixture.stableTokenProgram,
      sellerStockDeltaAtomic: (-input).toString(),
      makerStockDeltaAtomic: input.toString(),
      makerStableDeltaAtomic: (-gross).toString(),
      sellerStableDeltaAtomic: (gross - fee).toString(),
      feeStableDeltaAtomic: fee.toString(),
      fillReceipt: fillReceipt.toBase58(),
    };
  }
}

export class SubmissionUncertainError extends Error {
  constructor(readonly signature: string, message: string) {
    super(message);
    this.name = 'SubmissionUncertainError';
  }
}

export class LocalnetAssetProvider implements AssetProvider {
  private snapshot?: MintAccountSnapshot;
  private balances = new Map<string, string>();

  constructor(readonly fixture: LocalnetFixtureConfig, private readonly rpc: LocalnetRpcClient) {}

  list(): readonly AssetRegistryEntry[] { return [this.fixture.asset]; }

  mintSnapshot(asset: AssetRegistryEntry): MintAccountSnapshot {
    if (asset.mint !== this.fixture.stockMint || !this.snapshot) throw new Error('live localnet mint snapshot is unavailable');
    return this.snapshot;
  }

  balance(wallet: string, asset: AssetRegistryEntry): string { return this.balances.get(`${wallet}:${asset.mint}`) ?? '0'; }

  async refresh(wallet: string, inputMint: string, outputMint?: string): Promise<void> {
    if (wallet !== this.fixture.sellerPubkey || inputMint !== this.fixture.stockMint) {
      this.balances.set(`${wallet}:${inputMint}`, '0');
      throw new Error('connected Seller or stock mint does not match the governed local fixture');
    }
    await this.rpc.assertGovernedFixture(outputMint);
    const account = await this.rpc.account(this.fixture.stockMint);
    this.snapshot = {
      mint: this.fixture.stockMint,
      ownerProgram: this.fixture.asset.tokenProgram,
      decimals: this.fixture.stockDecimals,
      extensionFingerprint: this.fixture.stockExtensionFingerprint,
      extensions: [],
      paused: false,
      metadataPointer: this.fixture.asset.expectedMetadataPointer,
      issuerAuthorityFingerprint: this.fixture.asset.issuerAuthorityFingerprint,
      scaledUiAmountEnabled: false,
      memoTransferRequired: false,
    };
    this.balances.set(`${wallet}:${inputMint}`, await this.rpc.tokenBalance(this.fixture.sellerStockAccount, inputMint, this.fixture.stockTokenProgram));
    if (account.owner !== this.fixture.stockTokenProgram) throw new Error('live stock mint is not owned by the governed Token program');
  }
}

export class LocalnetQuoteSimulationProvider implements QuoteSimulationProvider {
  constructor(private readonly rpc: LocalnetRpcClient) {}

  async simulate(candidate: QuoteCandidate, nowMs: number) {
    const result = await this.rpc.simulate(candidate, false);
    return { ...result, simulatedAtMs: nowMs };
  }
}

export class LocalnetSourceBalanceProvider implements SourceBalanceProvider {
  constructor(private readonly rpc: LocalnetRpcClient) {}

  verify(source: QuoteSource, candidate: QuoteCandidate, _asset: AssetRegistryEntry, nowMs: number) {
    if (source.id !== candidate.sourceId || source.kind !== 'private-maker' || candidate.sourceKind !== 'private-maker') {
      throw new Error('localnet source liquidity is restricted to the governed Private Maker');
    }
    return this.rpc.verifySourceBalance(candidate, nowMs);
  }
}

export function createLocalnetAsset(fixture: Omit<LocalnetFixtureConfig, 'asset'>): AssetRegistryEntry {
  const issuerAuthorityBytes = decodeBase58(fixture.stockIssuerAuthority);
  if (!issuerAuthorityBytes || issuerAuthorityBytes.length !== 32) throw new Error('localnet stock mint authority is invalid');
  return localnetTestAsset({
    mint: fixture.stockMint,
    stableOutputs: fixture.stableMints,
    tokenProgram: 'spl-token',
    decimals: fixture.stockDecimals,
    extensionFingerprint: fixture.stockExtensionFingerprint,
    issuerAuthorityFingerprint: digest(Buffer.from(issuerAuthorityBytes)),
    expectedMetadataPointer: fixture.stockIssuerAuthority,
  });
}

export function loadMakerSecretKey(path: string): Uint8Array {
  const bytes = JSON.parse(readFileSync(resolve(path), 'utf8')) as number[];
  if (!Array.isArray(bytes) || (bytes.length !== 32 && bytes.length !== 64) || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('localnet Maker keypair file is malformed');
  }
  return Uint8Array.from(bytes.length === 64 ? bytes.slice(0, 32) : bytes);
}

export const LOCALNET_STABLE_MINTS = [USDC, USDT] as const;
export const LOCALNET_TOKEN_PROGRAM = TOKEN;
export const LOCALNET_SYSTEM_PROGRAM = SYSTEM;
