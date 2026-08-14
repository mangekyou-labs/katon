import { getAddress, isAddress, verifyMessage, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';

export interface NonceChallenge {
  readonly address: string;
  readonly domain: string;
  readonly chainId: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  used: boolean;
}

export interface NonceClaims {
  readonly address: string;
  readonly domain: string;
  readonly chainId: number;
  readonly now: number;
}

export class NonceStore {
  private sequence = 0;
  private readonly challenges = new Map<string, NonceChallenge>();

  issue(address: string, domain: string, chainId: number, issuedAt: number, ttlSeconds: number): string {
    if (!address || !domain || ttlSeconds <= 0) throw new Error('NONCE_INPUT');
    // EIP-4361 nonces are alphanumeric; keep the server sequence opaque while
    // remaining compatible with strict SIWE parsers.
    const nonce = `nonce${(++this.sequence).toString(36).padStart(8, '0')}`;
    this.challenges.set(nonce, {
      address,
      domain,
      chainId,
      issuedAt,
      expiresAt: issuedAt + ttlSeconds,
      used: false,
    });
    return nonce;
  }

  consume(nonce: string, claims: NonceClaims): true {
    const challenge = this.challenges.get(nonce);
    if (!challenge || challenge.used) throw new Error('NONCE_REPLAY');
    if (claims.now < challenge.issuedAt) throw new Error('NONCE_NOT_ACTIVE');
    if (claims.address.toLowerCase() !== challenge.address.toLowerCase()) throw new Error('NONCE_ADDRESS');
    if (claims.domain !== challenge.domain) throw new Error('NONCE_DOMAIN');
    if (claims.chainId !== challenge.chainId) throw new Error('NONCE_CHAIN');
    if (claims.now > challenge.expiresAt) throw new Error('NONCE_EXPIRED');
    challenge.used = true;
    return true;
  }
}

export interface SiweSessionInput {
  readonly message: string;
  readonly signature: Hex;
  readonly expectedDomain: string;
  readonly expectedChainId: number;
  readonly now: number;
  readonly nonces: NonceStore;
}

export async function verifySiweSession(input: SiweSessionInput): Promise<true> {
  const parsed = parseSiweMessage(input.message);
  if (!parsed.address || !isAddress(parsed.address, { strict: false })) throw new Error('SIWE_ADDRESS');
  if (parsed.domain !== input.expectedDomain) throw new Error('SIWE_DOMAIN');
  if (parsed.chainId !== input.expectedChainId) throw new Error('SIWE_CHAIN');
  if (parsed.version !== '1' || !parsed.uri || !parsed.nonce || !parsed.issuedAt) throw new Error('SIWE_FORMAT');
  if (!validateSiweMessage({
    message: parsed,
    address: parsed.address,
    domain: input.expectedDomain,
    time: new Date(input.now * 1_000),
  })) throw new Error('SIWE_TIME');

  const address = getAddress(parsed.address);
  if (!await verifyMessage({ address, message: input.message, signature: input.signature })) {
    throw new Error('SIWE_SIGNATURE');
  }
  input.nonces.consume(parsed.nonce, {
    address,
    domain: input.expectedDomain,
    chainId: input.expectedChainId,
    now: input.now,
  });
  return true;
}

export interface BotCredential {
  readonly id: string;
  readonly institution: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export class BotCredentialPolicy {
  private readonly credentials = new Map<string, BotCredential>();
  private readonly revoked = new Set<string>();

  register(credential: BotCredential): void {
    if (!credential.id || !credential.institution || credential.scopes.length === 0) {
      throw new Error('CREDENTIAL_INPUT');
    }
    this.credentials.set(credential.id, credential);
    this.revoked.delete(credential.id);
  }

  revoke(id: string): void {
    this.revoked.add(id);
  }

  authorize(id: string, institution: string, scope: string, now: number): true {
    if (this.revoked.has(id)) throw new Error('CREDENTIAL_REVOKED');
    const credential = this.credentials.get(id);
    if (!credential) throw new Error('CREDENTIAL_UNKNOWN');
    if (credential.institution !== institution) throw new Error('CREDENTIAL_INSTITUTION');
    if (credential.expiresAt <= now) throw new Error('CREDENTIAL_EXPIRED');
    if (!credential.scopes.includes(scope)) throw new Error('CREDENTIAL_SCOPE');
    return true;
  }
}
