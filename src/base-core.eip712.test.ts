import { describe, expect, it } from 'vitest';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  hashLiquidationFundingOrder,
  type LiquidationFundingOrder,
} from '../packages/base-core/src/eip712';

const DOMAIN = {
  name: EIP712_DOMAIN_NAME,
  version: EIP712_DOMAIN_VERSION,
  chainId: 84532,
  verifyingContract: '0x00000000000000000000000000000000000000aa' as const,
};

const ORDER: LiquidationFundingOrder = {
  maker: '0x0000000000000000000000000000000000000001',
  signer: '0x0000000000000000000000000000000000000002',
  debtAsset: '0x0000000000000000000000000000000000000010',
  collateralAsset: '0x0000000000000000000000000000000000000020',
  maxRepayAssets: 1_000_000n,
  minCollateralOut: 950_000n,
  fillMode: 0,
  expiry: 2_000_000_000n,
  salt: 7n,
  feeLimitBps: 0,
  rfqId: `0x${'00'.repeat(31)}42`,
  venue: '0x00000000000000000000000000000000000000bb',
  marketId: `0x${'00'.repeat(31)}43`,
};

describe('LiquidationFundingOrder EIP-712 hashing', () => {
  it('matches the pinned U-712-1 digest vector', () => {
    expect(hashLiquidationFundingOrder(ORDER, DOMAIN)).toBe(
      '0xfc2e8951a694f4bc700e363bef7d939ecd8fcd7da0e7922d49fb213bdd9df0f8',
    );
  });

  it('binds U-712-2 signatures to the configured chain', () => {
    expect(hashLiquidationFundingOrder(ORDER, DOMAIN)).not.toBe(
      hashLiquidationFundingOrder(ORDER, { ...DOMAIN, chainId: 8453 }),
    );
  });
});
