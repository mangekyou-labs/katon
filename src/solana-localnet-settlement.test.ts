import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { validateMakerSettlement } from '../apps/solana-api/src/maker-settlement';
import { buildLocalnetPrivateSettlement, localnetTestAsset } from '../apps/solana-api/src/localnet-settlement';

const PROGRAM_ID = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const STOCK_MINT = Keypair.generate().publicKey.toBase58();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const seller = Keypair.generate();
const maker = Keypair.generate();
const feeRecipient = Keypair.generate();
const associated = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, new PublicKey(PROGRAM_ID))[0];
const ata = (owner: PublicKey, mint: PublicKey, tokenProgram: string) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), mint.toBuffer()], associated,
)[0].toBase58();
const stockMint = new PublicKey(STOCK_MINT);

const fixture = {
  programId: PROGRAM_ID,
  stockMint: stockMint.toBase58(),
  stockTokenProgram: TOKEN_2022,
  stockDecimals: 6,
  stockExtensionFingerprint: createHash('sha256').update('local-test-mint-config').digest('hex'),
  sellerStockAccount: ata(seller.publicKey, stockMint, TOKEN_2022),
  makerStockAccount: ata(maker.publicKey, stockMint, TOKEN_2022),
  makerPublicKey: maker.publicKey.toBase58(),
  makerStableAccounts: { [USDC]: ata(maker.publicKey, new PublicKey(USDC), TOKEN) },
  sellerStableAccounts: { [USDC]: ata(seller.publicKey, new PublicKey(USDC), TOKEN) },
  feeStableAccounts: { [USDC]: ata(feeRecipient.publicKey, new PublicKey(USDC), TOKEN) },
  feeRecipient: feeRecipient.publicKey.toBase58(),
  stableTokenProgram: TOKEN,
  assetRegistry: pda(Buffer.from('asset'), stockMint.toBuffer()).toBase58(),
  makerRegistry: pda(Buffer.from('makers')).toBase58(),
  governance: pda(Buffer.from('governance')).toBase58(),
  feeBps: 10,
};
const asset = localnetTestAsset({
  mint: STOCK_MINT,
  stableOutputs: [USDC, Keypair.generate().publicKey.toBase58()],
  tokenProgram: 'token-2022',
  decimals: 6,
  extensionFingerprint: fixture.stockExtensionFingerprint,
  issuerAuthorityFingerprint: '77'.repeat(32),
});

describe('localnet Private Maker settlement builder', () => {
  it('issues a Maker-signed, Seller-reviewable RFQ v0 transaction with exact integer terms', async () => {
    const nowMs = Date.now();
    const issued = await buildLocalnetPrivateSettlement({
      fixture,
      sellerPublicKey: seller.publicKey.toBase58(),
      makerSecretKey: maker.secretKey,
      asset,
      request: { wallet: seller.publicKey.toBase58(), inputMint: STOCK_MINT, outputMint: USDC, inputAmountAtomic: '1000000' },
      grossStableAmountAtomic: '5000000',
      nowMs,
      expiresAtMs: nowMs + 20_000,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    });

    expect(issued.candidate.transactionBase64).toBeTruthy();
    expect(issued.candidate.settlementRoute).toBe('generic-spl');
    expect(issued.candidate.venueFeeAtomic).toBe('5000');
    expect(issued.candidate.netOutputAtomic).toBe('4995000');
    expect(issued.candidate.katonFeeAtomic).toBe('0');
    expect(issued.transaction.message.header.numRequiredSignatures).toBe(2);
    expect(issued.transaction.message.staticAccountKeys[0]?.toBase58()).toBe(seller.publicKey.toBase58());
    expect(issued.transaction.message.staticAccountKeys[1]?.toBase58()).toBe(maker.publicKey.toBase58());
    expect(issued.transaction.signatures[0]?.every((byte) => byte === 0)).toBe(true);
    expect(issued.transaction.signatures[1]?.some((byte) => byte !== 0)).toBe(true);
    expect(issued.terms.outputAmountAtomic).toBe('5000000');

    expect(() => validateMakerSettlement(issued.candidate.transactionBase64!, issued.terms, nowMs)).not.toThrow();
  });

  it('rejects a stable mint without a governed account set', async () => {
    await expect(buildLocalnetPrivateSettlement({
      fixture,
      sellerPublicKey: seller.publicKey.toBase58(),
      makerSecretKey: maker.secretKey,
      asset,
      request: { wallet: seller.publicKey.toBase58(), inputMint: STOCK_MINT, outputMint: Keypair.generate().publicKey.toBase58(), inputAmountAtomic: '1000000' },
      grossStableAmountAtomic: '5000000',
      nowMs: Date.now(),
      expiresAtMs: Date.now() + 20_000,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    })).rejects.toThrow(/stable output/);
  });

  it('rejects a Maker-signed transaction whose stock source account was changed', async () => {
    const nowMs = Date.now();
    const issued = await buildLocalnetPrivateSettlement({
      fixture,
      sellerPublicKey: seller.publicKey.toBase58(),
      makerSecretKey: maker.secretKey,
      asset,
      request: { wallet: seller.publicKey.toBase58(), inputMint: STOCK_MINT, outputMint: USDC, inputAmountAtomic: '1000000' },
      grossStableAmountAtomic: '5000000',
      nowMs,
      expiresAtMs: nowMs + 20_000,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    });
    const altered = VersionedTransaction.deserialize(Buffer.from(issued.candidate.transactionBase64!, 'base64'));
    const settle = altered.message.compiledInstructions.find((instruction) =>
      altered.message.staticAccountKeys[instruction.programIdIndex]?.toBase58() === PROGRAM_ID,
    );
    expect(settle).toBeTruthy();
    // Replace SellerStockAccount with MakerStockAccount while keeping valid message bytes.
    settle!.accountKeyIndexes[2] = settle!.accountKeyIndexes[3]!;

    expect(() => validateMakerSettlement(
      Buffer.from(altered.serialize()).toString('base64'), issued.terms, nowMs,
    )).toThrow(/account 2 does not match quote/);
  });
});
