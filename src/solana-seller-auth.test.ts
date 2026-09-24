import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeBase58 } from '../packages/solana-core/src/base58';
import { SellerSessionService } from '../apps/solana-api/src/seller-auth';

function sellerKey() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = encodeBase58(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  return { publicKey, privateKey: pair.privateKey };
}

function signature(message: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  return sign(null, Buffer.from(message), privateKey).toString('base64url');
}

describe('Seller wallet sessions', () => {
  const origin = 'http://localhost:5173';
  const cluster = 'localnet';

  it('issues a short-lived session from a one-use signed challenge bound to wallet, origin, and cluster', () => {
    let now = 10_000;
    const seller = sellerKey();
    const auth = new SellerSessionService('seller-test-secret-with-enough-entropy', cluster, 30_000, () => now);
    const challenge = auth.createChallenge(seller.publicKey, origin, cluster);
    expect(challenge.message).toContain(`wallet:${seller.publicKey}`);
    expect(challenge.message).toContain(`origin:${origin}`);
    expect(challenge.message).toContain(`cluster:${cluster}`);

    const session = auth.createSession(seller.publicKey, origin, cluster, challenge.challengeId, signature(challenge.message, seller.privateKey));
    expect(auth.authenticate(session.token, seller.publicKey, origin, cluster)).toMatchObject({
      wallet: seller.publicKey, origin, cluster, expiresAtMs: now + 30_000,
    });

    now += 30_001;
    expect(() => auth.authenticate(session.token, seller.publicKey, origin, cluster)).toThrow(/expired/i);
  });

  it('rejects missing, expired, replayed, wrong-wallet, wrong-origin, and wrong-cluster proof', () => {
    let now = 50_000;
    const seller = sellerKey();
    const otherSeller = sellerKey();
    const auth = new SellerSessionService('seller-test-secret-with-enough-entropy', cluster, 30_000, () => now);

    const expiring = auth.createChallenge(seller.publicKey, origin, cluster);
    now += 60_001;
    expect(() => auth.createSession(seller.publicKey, origin, cluster, expiring.challengeId, signature(expiring.message, seller.privateKey))).toThrow(/expired|missing/i);

    now = 70_000;
    const challenge = auth.createChallenge(seller.publicKey, origin, cluster);
    const proof = signature(challenge.message, seller.privateKey);
    const session = auth.createSession(seller.publicKey, origin, cluster, challenge.challengeId, proof);
    expect(() => auth.createSession(seller.publicKey, origin, cluster, challenge.challengeId, proof)).toThrow(/challenge/i);
    expect(() => auth.authenticate(session.token, otherSeller.publicKey, origin, cluster)).toThrow(/wallet/i);
    expect(() => auth.authenticate(session.token, seller.publicKey, 'http://localhost:5174', cluster)).toThrow(/origin/i);
    expect(() => auth.authenticate(session.token, seller.publicKey, origin, 'devnet')).toThrow(/cluster/i);
    expect(() => auth.createChallenge(seller.publicKey, origin, 'devnet')).toThrow(/cluster/i);

    const crossSeller = auth.createChallenge(otherSeller.publicKey, origin, cluster);
    expect(() => auth.createSession(otherSeller.publicKey, origin, cluster, crossSeller.challengeId, proof)).toThrow(/signature/i);
  });

  it('rejects malformed wallet keys and non-canonical origins', () => {
    const auth = new SellerSessionService('seller-test-secret-with-enough-entropy', cluster);
    expect(() => auth.createChallenge('not-a-wallet', origin, cluster)).toThrow(/wallet/i);
    expect(() => auth.createChallenge(sellerKey().publicKey, `${origin}/path`, cluster)).toThrow(/origin/i);
  });
});
