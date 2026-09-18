import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  BaseLpClient,
  buildFundingOrderTypedData,
  createCanonicalHmacHeaders,
  type SignedBidDto,
} from '../packages/base-sdk/src/index';

const MAKER = '0x0000000000000000000000000000000000000001' as Address;
const USDC = '0x0000000000000000000000000000000000000010' as Address;
const B20 = '0x0000000000000000000000000000000000000020' as Address;
const ADAPTER = '0x0000000000000000000000000000000000000050' as Address;
const RFQ_ID = `0x${'11'.repeat(32)}` as Hex;

const order = {
  maker: MAKER,
  signer: MAKER,
  debtAsset: USDC,
  collateralAsset: B20,
  maxRepayAssets: 100_000_000n,
  minCollateralOut: 90_000_000n,
  fillMode: 0,
  expiry: 2_000n,
  salt: 1n,
  feeLimitBps: 30,
  rfqId: RFQ_ID,
  venue: ADAPTER,
  marketId: `0x${'22'.repeat(32)}` as Hex,
} as const;

describe('M5 typed LP SDK', () => {
  it('serializes bigint API integers as canonical decimal strings', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toContain('"maxRepayAssets":"100000000"');
      expect(init?.body).toContain('"remainingCapacity":"100000000"');
      expect(init?.body).not.toContain('1e');
      return new Response(JSON.stringify({ rfqId: RFQ_ID, status: 'open' }), { status: 200 });
    });
    const client = new BaseLpClient({
      baseUrl: 'https://api.example.test',
      keyId: 'lp-1',
      secret: 'secret-not-for-logs',
      fetch: fetcher,
      clock: () => 1_000,
    });
    await client.placeBid({
      rfqId: RFQ_ID,
      order,
      signature: '0x1234',
      remainingCapacity: 100_000_000n,
      minCollateralOut: 90_000_000n,
      adapter: ADAPTER,
    });
    expect(fetcher).toHaveBeenCalledWith('https://api.example.test/v1/bids', expect.anything());
  });

  it('enforces TLS except for explicit loopback development opt-in', () => {
    expect(() => new BaseLpClient({ baseUrl: 'http://api.example.test', keyId: 'x', secret: 'y' })).toThrow('HTTPS_REQUIRED');
    expect(() => new BaseLpClient({ baseUrl: 'http://127.0.0.1:8788', keyId: 'x', secret: 'y' })).toThrow('HTTPS_REQUIRED');
    expect(() => new BaseLpClient({ baseUrl: 'http://127.0.0.1:8788', keyId: 'x', secret: 'y', allowInsecureLocal: true })).not.toThrow();
  });

  it('exports canonical HMAC headers and RFQ-bound typed data', () => {
    const headers = createCanonicalHmacHeaders('lp-1', 'secret', 'POST', '/v1/bids', 1_000, '{}');
    expect(headers['x-katon-key-id']).toBe('lp-1');
    expect(headers['x-katon-signature']).toMatch(/^0x[0-9a-f]{64}$/);
    expect(headers.authorization).not.toContain('secret');
    const typed = buildFundingOrderTypedData({ chainId: 84532, verifyingContract: USDC }, order);
    expect(typed.primaryType).toBe('LiquidationFundingOrder');
    expect(typed.message.maxRepayAssets).toBe(100_000_000n);
    expect(typed.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
  });

  it('keeps signed bid DTOs public while exposing no execution transaction API', () => {
    const dto: SignedBidDto = {
      rfqId: RFQ_ID,
      order,
      signature: '0x1234',
      remainingCapacity: 1n,
      minCollateralOut: 1n,
      adapter: ADAPTER,
    };
    expect(dto.order.maxRepayAssets).toBe(100_000_000n);
    expect(BaseLpClient.prototype).not.toHaveProperty('submitRoute');
    expect(BaseLpClient.prototype).not.toHaveProperty('executeSettlement');
  });
});
