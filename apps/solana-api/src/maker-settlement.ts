import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { bytesFromBase64 } from '@katon/solana-sdk';

const RFQ_PROGRAM = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const COMPUTE_BUDGET_PROGRAM = new PublicKey('ComputeBudget111111111111111111111111111111');
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const SETTLE_DISCRIMINATOR = createHash('sha256').update('global:settle_private_quote').digest().subarray(0, 8);

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

function exact(value: PublicKey | undefined, expected: PublicKey, name: string): void {
  if (!value?.equals(expected)) throw new Error(`maker settlement ${name} does not match quote`);
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

function validComputeBudget(data: Buffer): boolean {
  if (data.length === 0) return false;
  switch (data[0]) {
    case 1: return data.length === 5 && data.readUInt32LE(1) >= 32_768 && data.readUInt32LE(1) <= 262_144;
    case 2: return data.length === 5 && data.readUInt32LE(1) > 0 && data.readUInt32LE(1) <= 1_400_000;
    case 3: return data.length === 9 && data.readBigUInt64LE(1) <= 100_000_000n;
    case 4: return data.length === 5 && data.readUInt32LE(1) > 0 && data.readUInt32LE(1) <= 64 * 1024 * 1024;
    default: return false;
  }
}

/** Validate the exact frozen v0 transaction against the quote and RFQ Anchor ABI. */
export function validateMakerSettlement(transactionBase64: string, terms: MakerSettlementTerms, nowMs = Date.now()): void {
  let transaction: VersionedTransaction;
  try { transaction = VersionedTransaction.deserialize(bytesFromBase64(transactionBase64)); }
  catch { throw new Error('maker settlement transaction is malformed'); }

  const message = transaction.message;
  if (message.version !== 0 || message.addressTableLookups.length !== 0) {
    throw new Error('maker settlement must use a static v0 message without address lookup tables');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(terms.quoteId)) throw new Error('maker settlement quote ID is invalid');
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

  const keys = message.staticAccountKeys;
  const settlementInstructions = [] as typeof message.compiledInstructions;
  const computeBudgetTypes = new Set<number>();
  let memoSeen = false;
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program) throw new Error('maker settlement has an unresolved instruction program');
    const data = Buffer.from(instruction.data);
    if (program.equals(COMPUTE_BUDGET_PROGRAM)) {
      if (!validComputeBudget(data) || instruction.accountKeyIndexes.length !== 0 || computeBudgetTypes.has(data[0]!)) throw new Error('maker settlement compute budget instruction is not permitted');
      computeBudgetTypes.add(data[0]!);
      continue;
    }
    if (program.equals(MEMO_PROGRAM)) {
      const expectedMemo = `Katon RFQ settlement ${terms.quoteId.toLowerCase()}`;
      if (memoSeen || instruction.accountKeyIndexes.length !== 0 || data.toString('utf8') !== expectedMemo) throw new Error('maker settlement memo is not permitted');
      memoSeen = true;
      continue;
    }
    if (!program.equals(RFQ_PROGRAM)) throw new Error('maker settlement contains an extra instruction');
    settlementInstructions.push(instruction);
  }
  if (settlementInstructions.length !== 1) throw new Error('maker settlement must contain exactly one RFQ instruction');
  const instruction = settlementInstructions[0]!;
  if (instruction.accountKeyIndexes.length !== expectedAccounts.length) throw new Error('maker settlement account order does not match Anchor');
  instruction.accountKeyIndexes.forEach((index, accountIndex) => exact(keys[index], expectedAccounts[accountIndex]!, `account ${accountIndex}`));
  const expectedPrivileges = [
    [true, true], [true, true], [false, true], [false, true], [false, true],
    [false, true], [false, true], [false, false], [false, false], [false, false],
    [false, false], [false, false], [false, false], [false, false], [false, false],
    [false, true], [false, false],
  ] as const;
  instruction.accountKeyIndexes.forEach((index, accountIndex) => {
    const [signer, writable] = expectedPrivileges[accountIndex]!;
    if (message.isAccountSigner(index) !== signer || message.isAccountWritable(index) !== writable) {
      throw new Error(`maker settlement account ${accountIndex} privileges do not match Anchor`);
    }
  });

  const data = Buffer.from(instruction.data);
  if (data.length !== 122 || !data.subarray(0, 8).equals(SETTLE_DISCRIMINATOR)
    || !data.subarray(8, 40).equals(quoteId)) throw new Error('maker settlement instruction or quote ID is invalid');
  const issuedAt = data.readBigInt64LE(40);
  const expiry = data.readBigInt64LE(48);
  const stock = data.readBigUInt64LE(56);
  const makerMinimum = data.readBigUInt64LE(64);
  const gross = data.readBigUInt64LE(72);
  const sellerMinimum = data.readBigUInt64LE(80);
  const feeBps = data.readUInt16LE(88);
  const expectedFingerprint = fingerprintBytes(terms.extensionFingerprint);
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  const expectedExpiry = BigInt(Math.floor(terms.expiresAtMs / 1000));
  const fee = gross * BigInt(feeBps) / 10_000n;
  if (!data.subarray(90, 122).equals(expectedFingerprint)
    || stock !== BigInt(terms.inputAmountAtomic) || makerMinimum !== stock
    || gross !== BigInt(terms.outputAmountAtomic) || feeBps !== terms.feeBps
    || sellerMinimum !== gross - fee || issuedAt > nowSeconds || expiry !== expectedExpiry
    || expiry <= nowSeconds || expiry - issuedAt > 30n) {
    throw new Error('maker settlement economics, extension fingerprint, or expiry do not match quote');
  }
  if (message.header.numRequiredSignatures !== 2 || !keys[0]?.equals(seller) || !keys[1]?.equals(maker)) {
    throw new Error('maker settlement seller and maker must sign in Anchor order');
  }
}
