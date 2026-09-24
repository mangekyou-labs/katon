import { describe, expect, it, vi } from 'vitest';
import { LOCAL_MAKER_SEED, LOCAL_SELLER_SEED, buildLocalnetLandingV0Transaction, encodeBase58, publicKeyFromSeed } from '../packages/solana-core/src/wire';
import { SolanaApiClient } from '../packages/solana-sdk/src/api';
import { inspectLocalnetProofTransaction } from '../apps/solana-web/src/solanaClient';

describe('inspectLocalnetProofTransaction', () => {
  const sellerPubkey = publicKeyFromSeed(LOCAL_SELLER_SEED);
  const seller = encodeBase58(sellerPubkey);
  const recentBlockhash = new Uint8Array(32).fill(9);

  it.each([
    ['jupiter', undefined, seller, 1],
    ['private-maker', publicKeyFromSeed(LOCAL_MAKER_SEED), encodeBase58(publicKeyFromSeed(LOCAL_MAKER_SEED)), 2],
  ] as const)('accepts the %s 1-lamport proof transfer', (sourceKind, makerPubkey, recipient, signerCount) => {
    const transaction = buildLocalnetLandingV0Transaction({ sellerPubkey, makerPubkey, recentBlockhash });

    expect(inspectLocalnetProofTransaction(transaction.transactionBase64, seller, sourceKind)).toEqual({
      feePayer: seller,
      recipient,
      lamports: 1,
      systemProgram: '11111111111111111111111111111111',
      signerCount,
    });
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
