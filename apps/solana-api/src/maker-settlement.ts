import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { reviewFrozenSettlement, type FrozenSettlementSummary } from '@katon/solana-core';

const RFQ_PROGRAM = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

export interface MakerSettlementTerms {
  readonly quoteId: string;
  readonly wallet: string;
  readonly makerPublicKey: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
  readonly outputAmountAtomic: string;
  readonly feeBps: number;
  readonly expiresAtMs: number;
  /** Trusted governance-selected fee owner; never read from the maker quote. */
  readonly feeRecipient: string;
  readonly stockTokenProgram: string;
  readonly stableTokenProgram: string;
  readonly extensionFingerprint: string;
}

function key(value: string, name: string): PublicKey {
  try { return new PublicKey(value); }
  catch { throw new Error(`maker settlement ${name} is invalid`); }
}

function associatedToken(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

function pda(seeds: readonly (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync([...seeds], RFQ_PROGRAM)[0];
}

function fingerprintBytes(value: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  return createHash('sha256').update(value, 'utf8').digest();
}

function exact(actual: string, expected: PublicKey, index: number): void {
  if (actual !== expected.toBase58()) throw new Error(`maker settlement account ${index} does not match quote`);
}

/** Shared frozen review first; trusted account derivation and extension checks remain server-owned. */
export function validateMakerSettlement(
  transactionBase64: string,
  terms: MakerSettlementTerms,
  nowMs = Date.now(),
): FrozenSettlementSummary {
  if (!/^[1-9][0-9]*$/.test(terms.inputAmountAtomic) || !/^[1-9][0-9]*$/.test(terms.outputAmountAtomic)) {
    throw new Error('maker settlement amounts are invalid');
  }
  if (!Number.isSafeInteger(terms.feeBps) || terms.feeBps < 0 || terms.feeBps > 25) throw new Error('maker settlement fee is invalid');

  const seller = key(terms.wallet, 'seller');
  const maker = key(terms.makerPublicKey, 'maker');
  const stockMint = key(terms.inputMint, 'stock mint');
  const stableMint = key(terms.outputMint, 'stable mint');
  const stockTokenProgram = key(terms.stockTokenProgram, 'stock token program');
  const stableTokenProgram = key(terms.stableTokenProgram, 'stable token program');
  const feeRecipient = key(terms.feeRecipient, 'fee recipient');
  if (![TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58()].includes(stockTokenProgram.toBase58())
    || ![TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58()].includes(stableTokenProgram.toBase58())) {
    throw new Error('maker settlement token program is unsupported');
  }

  const gross = BigInt(terms.outputAmountAtomic);
  const expectedFee = gross * BigInt(terms.feeBps) / 10_000n;
  const summary = reviewFrozenSettlement(transactionBase64, {
    seller: seller.toBase58(),
    quoteId: terms.quoteId,
    inputMint: stockMint.toBase58(),
    outputMint: stableMint.toBase58(),
    inputAmountAtomic: terms.inputAmountAtomic,
    grossOutputAtomic: gross.toString(),
    netOutputAtomic: (gross - expectedFee).toString(),
    feeBps: terms.feeBps,
    expiresAtMs: terms.expiresAtMs,
  }, nowMs);

  const quoteId = Buffer.from(terms.quoteId, 'hex');
  const expectedAccounts = [
    seller,
    maker,
    associatedToken(seller, stockMint, stockTokenProgram),
    associatedToken(maker, stockMint, stockTokenProgram),
    associatedToken(maker, stableMint, stableTokenProgram),
    associatedToken(seller, stableMint, stableTokenProgram),
    associatedToken(feeRecipient, stableMint, stableTokenProgram),
    feeRecipient,
    stockMint,
    stableMint,
    stockTokenProgram,
    stableTokenProgram,
    pda([Buffer.from('asset'), stockMint.toBuffer()]),
    pda([Buffer.from('makers')]),
    pda([Buffer.from('governance')]),
    pda([Buffer.from('fill'), maker.toBuffer(), quoteId]),
    SYSTEM_PROGRAM,
  ];
  const actualAccounts = [
    summary.feePayer,
    summary.maker,
    summary.sellerStockAccount,
    summary.makerStockAccount,
    summary.makerStableAccount,
    summary.sellerStableAccount,
    summary.feeStableAccount,
    summary.feeRecipient,
    summary.stockMint,
    summary.stableMint,
    summary.stockTokenProgram,
    summary.stableTokenProgram,
    summary.assetRegistry,
    summary.makerRegistry,
    summary.governance,
    summary.fillReceipt,
    SYSTEM_PROGRAM.toBase58(),
  ];
  actualAccounts.forEach((actual, index) => exact(actual, expectedAccounts[index]!, index));

  const expectedFingerprint = fingerprintBytes(terms.extensionFingerprint).toString('hex');
  if (summary.extensionFingerprint !== expectedFingerprint) throw new Error('maker settlement extension fingerprint does not match quote');
  return summary;
}
