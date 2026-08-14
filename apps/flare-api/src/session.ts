import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getAddress, type Hex } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';

import { NonceStore, verifySiweSession } from '../../../packages/flare-core/src/auth';

export interface AuthChallenge {
  readonly nonce: string;
  readonly message: string;
  readonly address: string;
  readonly domain: string;
  readonly chainId: number;
  readonly expiresAt: number;
}

interface Session {
  readonly address: string;
  readonly expiresAt: number;
}

export class ApiSessionStore {
  private readonly nonces = new NonceStore();
  private readonly sessions = new Map<string, Session>();

  issueChallenge(addressInput: string, domain: string, chainId: number, now = Math.floor(Date.now() / 1_000)): AuthChallenge {
    const address = getAddress(addressInput);
    const expiresAt = now + 300;
    const nonce = this.nonces.issue(address, domain, chainId, now, 300);
    const message = createSiweMessage({
      address,
      chainId,
      domain,
      nonce,
      uri: `http://${domain}`,
      version: '1',
      statement: 'Sign in to TrustRFQ Flare coordination.',
      issuedAt: new Date(now * 1_000),
      expirationTime: new Date(expiresAt * 1_000),
    });
    return { nonce, message, address, domain, chainId, expiresAt };
  }

  async verify(message: string, signature: Hex, expectedDomain: string, expectedChainId: number, now = Math.floor(Date.now() / 1_000)): Promise<{ token: string; address: string; expiresAt: number }> {
    await verifySiweSession({ message, signature, expectedDomain, expectedChainId, now, nonces: this.nonces });
    const parsed = parseSiweMessage(message);
    if (!parsed.address) throw new Error('AUTH_ADDRESS');
    const address = getAddress(parsed.address);
    const token = randomUUID();
    const expiresAt = now + 3_600;
    this.sessions.set(token, { address, expiresAt });
    return { token, address, expiresAt };
  }

  authorize(token: string | undefined, wallet: string, now = Math.floor(Date.now() / 1_000)): true {
    if (!token) throw new Error('AUTH_REQUIRED');
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= now) throw new Error('AUTH_EXPIRED');
    if (session.address.toLowerCase() !== wallet.toLowerCase()) throw new Error('AUTH_WALLET_MISMATCH');
    return true;
  }

  static randomDomain(): string {
    return `trustrfq-${randomBytes(4).toString('hex')}.local`;
  }
}

export interface ApiBotCredential {
  readonly id: string;
  readonly wallet: string;
  readonly institution: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly revokedAt?: number;
}

export interface ApiBotCredentialSnapshot {
  readonly credentials: readonly (ApiBotCredential & { readonly tokenHash: string })[];
}

export class ApiBotCredentialStore {
  private readonly credentials = new Map<string, ApiBotCredential & { readonly tokenHash: string }>();

  issue(input: { readonly wallet: string; readonly institution: string; readonly scopes: readonly string[]; readonly expiresAt: number }, now = Math.floor(Date.now() / 1_000)): { readonly id: string; readonly token: string; readonly wallet: string; readonly institution: string; readonly scopes: readonly string[]; readonly expiresAt: number } {
    const wallet = getAddress(input.wallet);
    if (!input.institution.trim() || input.scopes.length === 0 || input.scopes.some((scope) => !scope.trim()) || !Number.isInteger(input.expiresAt) || input.expiresAt <= now) {
      throw new Error('CREDENTIAL_INPUT');
    }
    const id = `cred_${randomUUID()}`;
    const token = `trf_bot_${randomBytes(24).toString('base64url')}`;
    this.credentials.set(id, { id, wallet, institution: input.institution.trim(), scopes: [...new Set(input.scopes)], expiresAt: input.expiresAt, issuedAt: now, tokenHash: this.hash(token) });
    return { id, token, wallet, institution: input.institution.trim(), scopes: [...new Set(input.scopes)], expiresAt: input.expiresAt };
  }

  authorize(token: string, walletInput: string, scope: string, now = Math.floor(Date.now() / 1_000)): true {
    this.authorizedCredential(token, walletInput, scope, now);
    return true;
  }

  institution(token: string, walletInput: string, scope: string, now = Math.floor(Date.now() / 1_000)): string {
    return this.authorizedCredential(token, walletInput, scope, now).institution;
  }

  private authorizedCredential(token: string, walletInput: string, scope: string, now: number): ApiBotCredential & { readonly tokenHash: string } {
    const credential = [...this.credentials.values()].find((candidate) => candidate.tokenHash === this.hash(token));
    if (!credential) throw new Error('CREDENTIAL_UNKNOWN');
    if (credential.revokedAt !== undefined) throw new Error('CREDENTIAL_REVOKED');
    if (credential.expiresAt <= now) throw new Error('CREDENTIAL_EXPIRED');
    if (credential.wallet.toLowerCase() !== getAddress(walletInput).toLowerCase()) throw new Error('CREDENTIAL_WALLET');
    if (!credential.scopes.includes(scope)) throw new Error('CREDENTIAL_SCOPE');
    return credential;
  }

  revoke(id: string, now = Math.floor(Date.now() / 1_000)): void {
    const credential = this.credentials.get(id);
    if (!credential) throw new Error('CREDENTIAL_UNKNOWN');
    this.credentials.set(id, { ...credential, revokedAt: now });
  }

  snapshot(): ApiBotCredentialSnapshot {
    return { credentials: [...this.credentials.values()].map((credential) => ({ ...credential })) };
  }

  restore(snapshot: ApiBotCredentialSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.credentials)) throw new Error('CREDENTIAL_STORE_INVALID');
    this.credentials.clear();
    for (const credential of snapshot.credentials) {
      if (!credential || !credential.id || !credential.wallet || !credential.institution || !Array.isArray(credential.scopes) || !Number.isInteger(credential.issuedAt) || !Number.isInteger(credential.expiresAt)) throw new Error('CREDENTIAL_STORE_INVALID');
      if (!credential.tokenHash) throw new Error('CREDENTIAL_STORE_INVALID');
      this.credentials.set(credential.id, { ...credential });
    }
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
