import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { BotCredentialPolicy, NonceStore, verifySiweSession } from '../packages/flare-core/src/auth';

describe('blind-relay authentication boundary', () => {
  it('issues domain/chain-bound nonces that are single-use and time-limited', () => {
    const store = new NonceStore();
    const nonce = store.issue('0xAlice', 'app.example', 114, 1_000, 100);
    expect(store.consume(nonce, { address: '0xalice', domain: 'app.example', chainId: 114, now: 1_050 })).toBe(true);
    expect(() => store.consume(nonce, { address: '0xalice', domain: 'app.example', chainId: 114, now: 1_051 })).toThrow(
      'NONCE_REPLAY',
    );
    const other = store.issue('0xalice', 'app.example', 114, 1_000, 100);
    expect(() => store.consume(other, { address: '0xalice', domain: 'evil.example', chainId: 114, now: 1_050 })).toThrow(
      'NONCE_DOMAIN',
    );
    const future = store.issue('0xalice', 'app.example', 114, 2_000, 100);
    expect(() => store.consume(future, { address: '0xalice', domain: 'app.example', chainId: 114, now: 1_999 })).toThrow(
      'NONCE_NOT_ACTIVE',
    );
  });

  it('enforces scoped bot credentials and revocation', () => {
    const policy = new BotCredentialPolicy();
    policy.register({ id: 'bot-1', institution: 'desk-a', scopes: ['bid:submit'], expiresAt: 2_000 });
    expect(policy.authorize('bot-1', 'desk-a', 'bid:submit', 1_000)).toBe(true);
    expect(() => policy.authorize('bot-1', 'desk-a', 'bid:submit', 2_000)).toThrow('CREDENTIAL_EXPIRED');
    expect(() => policy.authorize('bot-1', 'desk-b', 'bid:submit', 1_000)).toThrow('CREDENTIAL_INSTITUTION');
    policy.revoke('bot-1');
    expect(() => policy.authorize('bot-1', 'desk-a', 'bid:submit', 1_000)).toThrow('CREDENTIAL_REVOKED');
  });

  it('verifies an EIP-4361 session before consuming its nonce', async () => {
    const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000a11');
    const store = new NonceStore();
    const nonce = store.issue(account.address, 'app.example', 114, 1_000, 100);
    const message = [
      `app.example wants you to sign in with your Ethereum account:`,
      `${account.address}`,
      ``,
      `TrustRFQ session`,
      ``,
      `URI: https://app.example/login`,
      `Version: 1`,
      `Chain ID: 114`,
      `Nonce: ${nonce}`,
      `Issued At: 1970-01-01T00:16:40.000Z`,
      `Expiration Time: 1970-01-01T00:18:20.000Z`,
    ].join('\n');
    const signature = await account.signMessage({ message });

    await expect(verifySiweSession({
      message,
      signature,
      expectedDomain: 'app.example',
      expectedChainId: 114,
      now: 1_050,
      nonces: store,
    })).resolves.toBe(true);
    await expect(verifySiweSession({
      message,
      signature,
      expectedDomain: 'app.example',
      expectedChainId: 114,
      now: 1_051,
      nonces: store,
    })).rejects.toThrow('NONCE_REPLAY');
  });
});
