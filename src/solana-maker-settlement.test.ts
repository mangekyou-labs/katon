import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { validateMakerSettlement } from '../apps/solana-api/src/maker-settlement';

const program = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
const token = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const token2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const associated = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const seller = Keypair.generate();
const maker = Keypair.generate();
const feeRecipient = Keypair.generate().publicKey;
const stockMint = Keypair.generate().publicKey;
const stableMint = Keypair.generate().publicKey;
const wrongAccount = Keypair.generate().publicKey;
const quoteId = '27'.repeat(32);
const extensionFingerprint = 'metadata-pointer|active|scaled|none|none|no-memo';

function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associated)[0];
}
function pda(seeds: Buffer[]): PublicKey { return PublicKey.findProgramAddressSync(seeds, program)[0]; }

function settlementData(stockAmount = 100_000n): Buffer {
  const data = Buffer.alloc(122);
  createHash('sha256').update('global:settle_private_quote').digest().subarray(0, 8).copy(data, 0);
  Buffer.from(quoteId, 'hex').copy(data, 8);
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  data.writeBigInt64LE(issuedAt, 40);
  data.writeBigInt64LE(issuedAt + 20n, 48);
  data.writeBigUInt64LE(stockAmount, 56);
  data.writeBigUInt64LE(stockAmount, 64);
  data.writeBigUInt64LE(100_000n, 72);
  data.writeBigUInt64LE(99_900n, 80);
  data.writeUInt16LE(10, 88);
  createHash('sha256').update(extensionFingerprint).digest().copy(data, 90);
  return data;
}

function settlementInstruction(
  data = settlementData(),
  reverseFirstAccounts = false,
  readonlyAccountIndex?: number,
  wrongAccountIndex?: number,
): TransactionInstruction {
  const accounts = [
    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
    { pubkey: maker.publicKey, isSigner: true, isWritable: true },
    { pubkey: ata(seller.publicKey, stockMint, token2022), isSigner: false, isWritable: true },
    { pubkey: ata(maker.publicKey, stockMint, token2022), isSigner: false, isWritable: true },
    { pubkey: ata(maker.publicKey, stableMint, token), isSigner: false, isWritable: true },
    { pubkey: ata(seller.publicKey, stableMint, token), isSigner: false, isWritable: true },
    { pubkey: ata(feeRecipient, stableMint, token), isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: false },
    { pubkey: stockMint, isSigner: false, isWritable: false },
    { pubkey: stableMint, isSigner: false, isWritable: false },
    { pubkey: token2022, isSigner: false, isWritable: false },
    { pubkey: token, isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('asset'), stockMint.toBuffer()]), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('makers')]), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('governance')]), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('fill'), maker.publicKey.toBuffer(), Buffer.from(quoteId, 'hex')]), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (reverseFirstAccounts) [accounts[0], accounts[1]] = [accounts[1]!, accounts[0]!];
  if (readonlyAccountIndex !== undefined) accounts[readonlyAccountIndex]!.isWritable = false;
  if (wrongAccountIndex !== undefined) accounts[wrongAccountIndex]!.pubkey = wrongAccount;
  return new TransactionInstruction({ programId: program, keys: accounts, data });
}

function signedTransaction(instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[] = []): string {
  const message = new TransactionMessage({
    payerKey: seller.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions],
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([seller, maker]);
  return Buffer.from(transaction.serialize()).toString('base64');
}

const terms = {
  quoteId,
  wallet: seller.publicKey.toBase58(),
  makerPublicKey: maker.publicKey.toBase58(),
  inputMint: stockMint.toBase58(),
  outputMint: stableMint.toBase58(),
  inputAmountAtomic: '100000',
  outputAmountAtomic: '100000',
  feeBps: 10,
  expiresAtMs: Math.floor(Date.now() / 1000) * 1000 + 20_000,
  feeRecipient: feeRecipient.toBase58(),
  stockTokenProgram: token2022.toBase58(),
  stableTokenProgram: token.toBase58(),
  extensionFingerprint,
};

describe('Maker settlement transaction binding', () => {
  it('accepts the exact Anchor settlement and signed quote terms', () => {
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction()]), terms)).not.toThrow();
  });

  it.each([
    ['quote ID', (data: Buffer) => Buffer.from('28'.repeat(32), 'hex').copy(data, 8), /quote terms/],
    ['issue time', (data: Buffer) => data.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 1), 40), /economics|expiry/],
    ['expiry', (data: Buffer) => data.writeBigInt64LE(BigInt(Math.floor(terms.expiresAtMs / 1000) + 1), 48), /economics|expiry/],
    ['stock amount', (data: Buffer) => data.writeBigUInt64LE(99_999n, 56), /quote terms/],
    ['maker minimum', (data: Buffer) => data.writeBigUInt64LE(99_999n, 64), /quote terms/],
    ['gross stable amount', (data: Buffer) => data.writeBigUInt64LE(99_999n, 72), /quote terms/],
    ['seller minimum', (data: Buffer) => data.writeBigUInt64LE(99_901n, 80), /quote terms/],
    ['fee', (data: Buffer) => data.writeUInt16LE(9, 88), /quote terms/],
    ['extension fingerprint', (data: Buffer) => { data[90] ^= 1; }, /fingerprint/],
  ] as const)('rejects a correctly signed settlement with a different %s', (_field, mutate, error) => {
    const data = settlementData();
    mutate(data);
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction(data)]), terms)).toThrow(error);
  });

  it('rejects an Anchor account whose compiled writable privilege is missing', () => {
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction(settlementData(), false, 2)]), terms))
      .toThrow(/privileges/);
  });

  it('rejects account reordering and extra instructions', () => {
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction(settlementData(), true)]), terms))
      .toThrow(/account/);
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction(settlementData(), false, undefined, 4)]), terms))
      .toThrow(/account/);
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction(), SystemProgram.transfer({
      fromPubkey: seller.publicKey, toPubkey: maker.publicKey, lamports: 1,
    })]), terms)).toThrow(/other instructions|extra instruction/i);
  });

  it('rejects extra compute settings, memo instructions, lookup tables, and an empty maker signature slot', () => {
    expect(() => validateMakerSettlement(signedTransaction([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), settlementInstruction(),
    ]), terms)).toThrow(/one compute limit|no other instructions/i);

    const memo = new TransactionInstruction({
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('memo'),
    });
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction(), memo]), terms))
      .toThrow(/one compute limit|no other instructions/i);

    const lookup = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
        authority: undefined, addresses: [feeRecipient],
      },
    });
    expect(() => validateMakerSettlement(signedTransaction([settlementInstruction()], [lookup]), terms))
      .toThrow(/address lookup tables/i);

    const serialized = Buffer.from(signedTransaction([settlementInstruction()]), 'base64');
    serialized.fill(0, 1 + 64, 1 + 128);
    expect(() => validateMakerSettlement(serialized.toString('base64'), terms)).toThrow(/maker signature slot is empty/i);
  });
});
