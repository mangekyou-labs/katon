import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { encodeBase58, LOCAL_SELLER_SEED, publicKeyFromSeed } from '../packages/solana-core/src/wire';
import { SolanaApiClient } from '../packages/solana-sdk/src/api';
import { buildLocalnetPrivateSettlement, localnetTestAsset } from '../apps/solana-api/src/localnet-settlement';
import { inspectLocalnetSettlementTransaction } from '../apps/solana-web/src/solanaClient';

describe('inspectLocalnetSettlementTransaction', () => {
  const sellerKey = Keypair.fromSeed(LOCAL_SELLER_SEED);
  const seller = sellerKey.publicKey.toBase58();
  const maker = Keypair.generate();
  const feeRecipient = Keypair.generate();
  const stockMint = Keypair.generate().publicKey;
  const stableMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const programId = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
  const ata = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([
    owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), mint.toBuffer(),
  ], associatedTokenProgram)[0].toBase58();
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0].toBase58();
  const fixture = {
    programId: programId.toBase58(), stockMint: stockMint.toBase58(), stockTokenProgram: tokenProgram,
    stockDecimals: 6, stockExtensionFingerprint: '00'.repeat(32), sellerStockAccount: ata(sellerKey.publicKey, stockMint),
    makerStockAccount: ata(maker.publicKey, stockMint), makerPublicKey: maker.publicKey.toBase58(),
    makerStableAccounts: { [stableMint.toBase58()]: ata(maker.publicKey, stableMint) },
    sellerStableAccounts: { [stableMint.toBase58()]: ata(sellerKey.publicKey, stableMint) },
    feeStableAccounts: { [stableMint.toBase58()]: ata(feeRecipient.publicKey, stableMint) },
    feeRecipient: feeRecipient.publicKey.toBase58(), stableTokenProgram: tokenProgram,
    assetRegistry: pda(Buffer.from('asset'), stockMint.toBuffer()),
    makerRegistry: pda(Buffer.from('makers')), governance: pda(Buffer.from('governance')), feeBps: 10,
  };
  const alternateStableMint = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
  const asset = localnetTestAsset({
    mint: fixture.stockMint, stableOutputs: [stableMint.toBase58(), alternateStableMint.toBase58()], tokenProgram: 'spl-token', decimals: 6,
    extensionFingerprint: fixture.stockExtensionFingerprint, issuerAuthorityFingerprint: '77'.repeat(32),
  });

  async function issue() {
    const nowMs = Date.now();
    return buildLocalnetPrivateSettlement({
      fixture, sellerPublicKey: seller, makerSecretKey: maker.secretKey, asset,
      request: { wallet: seller, inputMint: fixture.stockMint, outputMint: stableMint.toBase58(), inputAmountAtomic: '1000000' },
      grossStableAmountAtomic: '5000000', nowMs, expiresAtMs: nowMs + 20_000,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    });
  }

  it('decodes the exact Seller debit, net minimum, fee payer, and RFQ instruction', async () => {
    const issued = await issue();
    const summary = inspectLocalnetSettlementTransaction(issued.candidate.transactionBase64!, seller, {
      sourceKind: 'private-maker', quoteId: issued.candidate.quoteId, inputMint: fixture.stockMint,
      outputMint: stableMint.toBase58(), inputAmountAtomic: '1000000', grossOutputAtomic: '5000000',
      netOutputAtomic: '4995000', feeBps: issued.terms.feeBps, expiresAtMs: issued.candidate.expiresAtMs,
    });
    expect(summary).toMatchObject({
      feePayer: seller, maker: fixture.makerPublicKey, programId: fixture.programId,
      stockMint: fixture.stockMint, stableMint: stableMint.toBase58(),
      sellerStockAccount: fixture.sellerStockAccount, sellerStableAccount: fixture.sellerStableAccounts[stableMint.toBase58()],
      stockDebitAtomic: '1000000', grossStableAtomic: '5000000', netStableMinimumAtomic: '4995000',
      feeAtomic: '5000', feeBps: 10, signerCount: 2,
      executableInstructions: ['Compute Budget · set limit 400,000 CU', 'solana_rfq · settle_private_quote'],
    });
  });

  it('rejects a modified issued message, wrong Seller, or Jupiter stub', async () => {
    const issued = await issue();
    const expected = {
      sourceKind: 'private-maker' as const, quoteId: issued.candidate.quoteId,
      inputMint: fixture.stockMint, outputMint: stableMint.toBase58(), inputAmountAtomic: '1000000',
      grossOutputAtomic: '5000000', netOutputAtomic: '4995000', feeBps: issued.terms.feeBps, expiresAtMs: issued.candidate.expiresAtMs,
    };
    const altered = VersionedTransaction.deserialize(Buffer.from(issued.candidate.transactionBase64!, 'base64'));
    const settle = altered.message.compiledInstructions.find((instruction) => altered.message.staticAccountKeys[instruction.programIdIndex]?.equals(programId));
    expect(settle).toBeTruthy();
    settle!.data[56] ^= 1;
    expect(() => inspectLocalnetSettlementTransaction(Buffer.from(altered.serialize()).toString('base64'), seller, expected)).toThrow(/do not match review/i);
    expect(() => inspectLocalnetSettlementTransaction(issued.candidate.transactionBase64!, Keypair.generate().publicKey.toBase58(), expected)).toThrow(/fee payer/i);
    expect(() => inspectLocalnetSettlementTransaction(issued.candidate.transactionBase64!, seller, { ...expected, sourceKind: 'jupiter' })).toThrow(/non-executable/i);
  });
});

describe('SolanaApiClient Seller session', () => {
  it('signs one challenge and sends the bound session on every Seller read and write', async () => {
    const wallet = encodeBase58(publicKeyFromSeed(LOCAL_SELLER_SEED));
    const signature = new Uint8Array(64).fill(17);
    const seen: Array<{ url: string; method: string; authorization: string | undefined; origin: string | undefined; cluster: string | undefined }> = [];
    const fetcher = vi.fn<typeof fetch>(async function (this: unknown, input, init) {
      expect(this).toBe(globalThis);
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization') ?? undefined,
        origin: headers.get('x-katon-origin') ?? undefined,
        cluster: headers.get('x-katon-cluster') ?? undefined,
      });
      if (url.endsWith('/v1/seller-sessions/challenge')) {
        return Response.json({ challengeId: 'one-use-123', message: 'Katon Seller challenge bytes' });
      }
      if (url.endsWith('/v1/seller-sessions')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ publicKey: wallet, challengeId: 'one-use-123', signature: Buffer.from(signature).toString('base64url') });
        return Response.json({ token: 'seller-token', wallet, cluster: 'localnet', expiresAtMs: Date.now() + 60_000 });
      }
      if (url.includes('/v1/quote-sprints')) return Response.json({ id: 'sprint-live', request: { wallet }, winner: { transactionBase64: 'private-transaction-bytes' } });
      if (url.endsWith('/v1/execution-attempts')) return Response.json({ attemptId: 'attempt-1', quoteSprintId: 'sprint-live', status: 'provisional' });
      if (url.endsWith('/v1/trades')) return Response.json([]);
      return Response.json([]);
    });
    const client = new SolanaApiClient({ baseUrl: 'http://localhost:8787', fetcher, origin: 'http://localhost:5173' });
    const signMessage = vi.fn(async (message: Uint8Array) => {
      expect(new TextDecoder().decode(message)).toBe('Katon Seller challenge bytes');
      return signature;
    });

    const session = await client.authenticateSeller(wallet, 'localnet', signMessage);
    expect(session).toMatchObject({ wallet, cluster: 'localnet', token: 'seller-token' });
    expect(signMessage).toHaveBeenCalledOnce();
    await client.listAssets(wallet, 'stable-mint');
    await client.createQuoteSprint({ wallet, inputMint: 'stock-mint', outputMint: 'stable-mint', inputAmountAtomic: '100' });
    await client.getQuoteSprint('sprint-live');
    await client.reviewQuoteSprint('sprint-live', wallet);
    await client.authorizeQuoteSprint('sprint-live', { wallet, reviewHash: 'review-hash', signedTransactionBase64: 'signed-bytes' });
    await client.createExecutionAttempt({ quoteSprintId: 'sprint-live', idempotencyKey: 'attempt-1' });
    await client.listTrades(wallet);

    const sellerRequests = seen.filter(({ url }) => !url.endsWith('/v1/seller-sessions/challenge') && !url.endsWith('/v1/seller-sessions'));
    expect(sellerRequests).toHaveLength(7);
    for (const request of sellerRequests) {
      expect(request.authorization).toBe('Bearer seller-token');
      expect(request.origin).toBe('http://localhost:5173');
      expect(request.cluster).toBe('localnet');
    }
    expect(client.eventsUrl('sprint-live')).toContain('/v1/quote-sprints/sprint-live/events');
  });

  it('blocks absent, expired, and cross-wallet SDK sessions before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SolanaApiClient({ fetcher });
    await expect(client.listTrades('wallet')).rejects.toThrow(/session is missing or expired/i);
    client.setSellerSession({ token: 'seller-token', wallet: 'seller-one', cluster: 'localnet', expiresAtMs: Date.now() + 60_000 });
    await expect(client.listAssets('seller-two', 'stable')).rejects.toThrow(/does not match/i);
    client.setSellerSession({ token: 'seller-token', wallet: 'seller-one', cluster: 'localnet', expiresAtMs: Date.now() - 1 });
    await expect(client.getQuoteSprint('private-sprint')).rejects.toThrow(/session is missing or expired/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(client.activeSellerSession()).toBeUndefined();
  });
});
