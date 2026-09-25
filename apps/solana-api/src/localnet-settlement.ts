import { createHash, randomBytes } from 'node:crypto';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { seedFromSecretKey, withComputedPrivateFee } from '@katon/solana-core';
import type { AssetRegistryEntry, QuoteCandidate, QuoteSessionRequest } from '@katon/solana-core';
import type { MakerSettlementTerms } from './maker-settlement';

export const SOLANA_RFQ_PROGRAM_ID = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export interface LocalnetSettlementFixture {
  readonly programId: string;
  readonly stockMint: string;
  readonly stockTokenProgram: string;
  readonly stockDecimals: number;
  readonly stockExtensionFingerprint: string;
  readonly sellerStockAccount: string;
  readonly makerStockAccount: string;
  readonly makerPublicKey: string;
  readonly sellerPublicKey?: string;
  readonly makerStableAccounts: Readonly<Record<string, string>>;
  readonly sellerStableAccounts: Readonly<Record<string, string>>;
  readonly feeStableAccounts: Readonly<Record<string, string>>;
  readonly feeRecipient: string;
  readonly stableTokenProgram: string;
  readonly assetRegistry: string;
  readonly makerRegistry: string;
  readonly governance: string;
  readonly feeBps: number;
}

export interface BuildLocalnetPrivateSettlementInput {
  readonly fixture: LocalnetSettlementFixture;
  readonly sellerPublicKey: string;
  readonly makerSecretKey: Uint8Array;
  readonly asset: AssetRegistryEntry;
  readonly request: QuoteSessionRequest;
  readonly grossStableAmountAtomic: string;
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly recentBlockhash: string;
}

export interface BuiltLocalnetPrivateSettlement {
  readonly candidate: QuoteCandidate;
  readonly terms: MakerSettlementTerms;
  readonly transaction: VersionedTransaction;
}

function publicKey(value: string, label: string): PublicKey {
  try { return new PublicKey(value); }
  catch { throw new Error(`localnet settlement ${label} is invalid`); }
}

function pda(program: PublicKey, ...seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

function feeAtomic(gross: bigint, feeBps: number): bigint {
  return gross * BigInt(feeBps) / 10_000n;
}

function settlementInstructionData(input: {
  readonly quoteId: Buffer;
  readonly issuedAtSeconds: bigint;
  readonly expirySeconds: bigint;
  readonly stockAmount: bigint;
  readonly grossStableAmount: bigint;
  readonly feeBps: number;
  readonly extensionFingerprint: Buffer;
}): Buffer {
  const data = Buffer.alloc(122);
  createHash('sha256').update('global:settle_private_quote').digest().subarray(0, 8).copy(data, 0);
  input.quoteId.copy(data, 8);
  data.writeBigInt64LE(input.issuedAtSeconds, 40);
  data.writeBigInt64LE(input.expirySeconds, 48);
  data.writeBigUInt64LE(input.stockAmount, 56);
  data.writeBigUInt64LE(input.stockAmount, 64);
  data.writeBigUInt64LE(input.grossStableAmount, 72);
  data.writeBigUInt64LE(input.grossStableAmount - feeAtomic(input.grossStableAmount, input.feeBps), 80);
  data.writeUInt16LE(input.feeBps, 88);
  input.extensionFingerprint.copy(data, 90);
  return data;
}

/** Build the exact Anchor settlement message, then leave the Seller signature slot empty. */
export async function buildLocalnetPrivateSettlement(
  input: BuildLocalnetPrivateSettlementInput,
): Promise<BuiltLocalnetPrivateSettlement> {
  const { fixture, request, asset } = input;
  if (fixture.programId !== SOLANA_RFQ_PROGRAM_ID) throw new Error('localnet settlement RFQ program does not match signed policy');
  if (request.inputMint !== fixture.stockMint || request.inputMint !== asset.mint) throw new Error('localnet settlement stock mint does not match signed policy');
  if (request.outputMint !== asset.supportedOutputs[0] && request.outputMint !== asset.supportedOutputs[1]) throw new Error('localnet settlement stable output is not registry-approved');
  if (!/^[1-9][0-9]*$/.test(request.inputAmountAtomic) || !/^[1-9][0-9]*$/.test(input.grossStableAmountAtomic)) throw new Error('localnet settlement amounts are invalid');
  if (!/^[0-9a-fA-F]{64}$/.test(fixture.stockExtensionFingerprint)) throw new Error('localnet settlement mint fingerprint is invalid');
  if (!Number.isSafeInteger(fixture.feeBps) || fixture.feeBps < 0 || fixture.feeBps > 25) throw new Error('localnet settlement fee policy is invalid');
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= input.nowMs || input.expiresAtMs - input.nowMs > 30_000) throw new Error('localnet settlement expiry is invalid');

  const stableMint = publicKey(request.outputMint, 'stable mint');
  const makerStable = fixture.makerStableAccounts[request.outputMint];
  const sellerStable = fixture.sellerStableAccounts[request.outputMint];
  const feeStable = fixture.feeStableAccounts[request.outputMint];
  if (!makerStable || !sellerStable || !feeStable) throw new Error('localnet settlement stable output has no governed account set');
  const program = publicKey(fixture.programId, 'program ID');
  const seller = publicKey(input.sellerPublicKey, 'Seller');
  const makerSecret = seedFromSecretKey(input.makerSecretKey);
  const makerKeypair = Keypair.fromSeed(Buffer.from(makerSecret));
  if (makerKeypair.publicKey.toBase58() !== fixture.makerPublicKey) throw new Error('localnet settlement Maker key does not match governed registry');
  const quoteId = randomBytes(32);
  const issuedAtSeconds = BigInt(Math.floor(input.nowMs / 1_000));
  const expirySeconds = BigInt(Math.floor(input.expiresAtMs / 1_000));
  if (expirySeconds <= issuedAtSeconds || expirySeconds - issuedAtSeconds > 30n) throw new Error('localnet settlement expiry is outside the RFQ window');
  const fingerprint = Buffer.from(fixture.stockExtensionFingerprint, 'hex');
  const stockMint = publicKey(fixture.stockMint, 'stock mint');
  const stockTokenProgram = publicKey(fixture.stockTokenProgram, 'stock token program');
  const stableTokenProgram = publicKey(fixture.stableTokenProgram, 'stable token program');
  const maker = makerKeypair.publicKey;
  const feeRecipient = publicKey(fixture.feeRecipient, 'fee recipient');
  const fillReceipt = pda(program, Buffer.from('fill'), maker.toBuffer(), quoteId);
  const accounts = [
    { pubkey: seller, isSigner: true, isWritable: true },
    { pubkey: maker, isSigner: true, isWritable: true },
    { pubkey: publicKey(fixture.sellerStockAccount, 'Seller stock account'), isSigner: false, isWritable: true },
    { pubkey: publicKey(fixture.makerStockAccount, 'Maker stock account'), isSigner: false, isWritable: true },
    { pubkey: publicKey(makerStable, 'Maker stable account'), isSigner: false, isWritable: true },
    { pubkey: publicKey(sellerStable, 'Seller stable account'), isSigner: false, isWritable: true },
    { pubkey: publicKey(feeStable, 'fee stable account'), isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: false },
    { pubkey: stockMint, isSigner: false, isWritable: false },
    { pubkey: stableMint, isSigner: false, isWritable: false },
    { pubkey: stockTokenProgram, isSigner: false, isWritable: false },
    { pubkey: stableTokenProgram, isSigner: false, isWritable: false },
    { pubkey: publicKey(fixture.assetRegistry, 'asset registry'), isSigner: false, isWritable: false },
    { pubkey: publicKey(fixture.makerRegistry, 'Maker registry'), isSigner: false, isWritable: false },
    { pubkey: publicKey(fixture.governance, 'governance'), isSigner: false, isWritable: false },
    { pubkey: fillReceipt, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
  ];
  const instruction = new TransactionInstruction({
    programId: program,
    keys: accounts,
    data: settlementInstructionData({
      quoteId,
      issuedAtSeconds,
      expirySeconds,
      stockAmount: BigInt(request.inputAmountAtomic),
      grossStableAmount: BigInt(input.grossStableAmountAtomic),
      feeBps: fixture.feeBps,
      extensionFingerprint: fingerprint,
    }),
  });
  // A modest CU limit is explicit and permitted by the settlement validator.
  const message = new TransactionMessage({
    payerKey: seller,
    recentBlockhash: input.recentBlockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), instruction],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([makerKeypair]);
  const transactionBase64 = Buffer.from(transaction.serialize()).toString('base64');
  const gross = BigInt(input.grossStableAmountAtomic);
  const fee = feeAtomic(gross, fixture.feeBps);
  const quoteIdHex = quoteId.toString('hex');
  const expiresAtMs = Number(expirySeconds) * 1_000;
  const candidate = withComputedPrivateFee({
    quoteId: quoteIdHex,
    sourceId: 'maker-sandbox-01',
    sourceKind: 'private-maker',
    settlementRoute: 'generic-spl',
    router: 'katon/private-rfq',
    wallet: request.wallet,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    grossOutputAtomic: gross.toString(),
    venueFeeAtomic: fee.toString(),
    referencePriceAtomic: asset.referencePriceAtomic,
    referencePriceDecimals: asset.referencePriceDecimals,
    deviationBps: 8,
    priceImpactBps: 1,
    createdAtMs: input.nowMs,
    expiresAtMs,
    reliabilityBps: 9_700,
    transactionVersion: 'v0',
    transactionBase64,
    simulation: { ok: false, errorCode: 'awaiting_rpc_simulation', simulatedAtMs: input.nowMs },
    feeBps: 0,
  });
  const terms: MakerSettlementTerms = {
    quoteId: quoteIdHex,
    wallet: input.sellerPublicKey,
    makerPublicKey: maker.toBase58(),
    inputMint: fixture.stockMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    outputAmountAtomic: gross.toString(),
    feeBps: fixture.feeBps,
    expiresAtMs,
    feeRecipient: fixture.feeRecipient,
    stockTokenProgram: fixture.stockTokenProgram,
    stableTokenProgram: fixture.stableTokenProgram,
    extensionFingerprint: fixture.stockExtensionFingerprint,
  };
  return { candidate, terms, transaction };
}

export function localnetTestAsset(input: {
  readonly mint: string;
  readonly stableOutputs: readonly [string, string];
  readonly tokenProgram: 'spl-token' | 'token-2022';
  readonly decimals: number;
  readonly extensionFingerprint: string;
  readonly issuerAuthorityFingerprint: string;
  readonly expectedMetadataPointer?: string;
  readonly referencePriceAtomic?: string;
  readonly nowMs?: number;
}): AssetRegistryEntry {
  return {
    mint: input.mint,
    issuer: 'xstocks',
    ticker: 'AAPLx TEST',
    underlyingTicker: 'AAPL',
    tokenProgram: input.tokenProgram,
    decimals: input.decimals,
    issuerAuthorityFingerprint: input.issuerAuthorityFingerprint,
    ...(input.expectedMetadataPointer === undefined ? {} : { expectedMetadataPointer: input.expectedMetadataPointer }),
    extensionFingerprint: input.extensionFingerprint,
    capabilities: {
      transferHook: false,
      pausable: false,
      scaledUiAmount: false,
      transferFee: false,
      permanentDelegate: false,
      memoTransfer: false,
      confidentialTransfer: false,
    },
    supportedOutputs: input.stableOutputs,
    referenceState: 'open',
    referencePriceAtomic: input.referencePriceAtomic ?? '100000000',
    referencePriceDecimals: 6,
    referenceTimestampMs: input.nowMs ?? Date.now(),
    maxDeviationBps: 150,
    enabled: true,
    registryVersion: 1,
  };
}

export function assertLocalnetPolicyIdentity(fixture: LocalnetSettlementFixture, asset: AssetRegistryEntry): void {
  if (fixture.programId !== SOLANA_RFQ_PROGRAM_ID || fixture.stockMint !== asset.mint
    || fixture.stockTokenProgram !== (asset.tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID)
    || fixture.stockDecimals !== asset.decimals || fixture.stockExtensionFingerprint !== asset.extensionFingerprint) {
    throw new Error('localnet stock mint or Token program has drifted from the governed test policy');
  }
}

export function fingerprintPublicKey(publicKeyBase58: string): string {
  return createHash('sha256').update(new PublicKey(publicKeyBase58).toBuffer()).digest('hex');
}
