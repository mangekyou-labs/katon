import { describe, expect, it } from 'vitest';

import {
  B20_ASSETS_BY_ADDRESS,
  USDBC_ADDRESS,
  assertDebtAsset,
  assertFacilityAsset,
  getB20AssetByAddress,
} from '../packages/base-core/src/assets';
import { B20_SYSTEM_CONTRACTS } from '../packages/base-core/src/b20';
import { getBaseNetworkConfig } from '../packages/base-core/src/network';
import {
  CHAINLINK_FEED_DEVIATION_BPS,
  CHAINLINK_FEED_HEARTBEAT_SECONDS,
  CHAINLINK_TOTAL_RETURN_FEEDS_BY_TOKEN,
  chainlinkAnswerToWad,
} from '../packages/base-core/src/oracles';

const expectedB20Feeds = {
  '0xb200000000000000000000C2e324d24d7eEcd1fb': '0x787f13dEa48Db0897CbCDD985de77809D837F988',
  '0xb200000000000000000000d9192b6B456483C2E8': '0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295',
  '0xb200000000000000000000c85a31389D71F3ecfb': '0x408e44f504A7371a345F03a73dDC96A4b48e8aa7',
  '0xB20000000000000000000019f6E7C675b73C2e4D': '0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33',
  '0xb2000000000000000000002D0BA3164cc74f58B7': '0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2',
  '0xB2000000000000000000004AFF16039bA04bdFBc': '0xAB657C39bac0D5886250D70849e2E3E008F2EECB',
  '0xb2000000000000000000008bC8786B856E61707C': '0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D',
  '0xB200000000000000000000Ab99cFa739E253872B': '0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c',
  '0xb2000000000000000000004884b426556b92883d': '0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a',
  '0xb20000000000000000000078ee7ce2fE4908108C': '0x04689a41629776563E6822F76f2e57D148d28513',
  '0xb200000000000000000000397293Cb8cda9a10c5': '0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA',
  '0xb2000000000000000000007b9fcbd005511aCBd5': '0x6A634B235903C4ad6376892180d6fF8612e3Fa68',
  '0xb2000000000000000000001e800a7f5189430cD0': '0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4',
} as const;

describe('Base asset manifests', () => {
  it('keys all official B20 entries by address and pairs every token with its feed', () => {
    expect(Object.keys(B20_ASSETS_BY_ADDRESS)).toHaveLength(13);
    for (const [token, feed] of Object.entries(expectedB20Feeds)) {
      expect(B20_ASSETS_BY_ADDRESS[token as keyof typeof B20_ASSETS_BY_ADDRESS].feed).toBe(feed);
    }
    expect(CHAINLINK_TOTAL_RETURN_FEEDS_BY_TOKEN).toEqual(expectedB20Feeds);
  });

  it('rejects ticker-only B20 lookup keys', () => {
    expect(() => getB20AssetByAddress('AAPLc')).toThrow('INVALID_B20_ADDRESS');
  });

  it('accepts native Circle USDC and rejects bridged USDbC for facility and debt assets', () => {
    expect(assertFacilityAsset('sepolia', getBaseNetworkConfig('sepolia').nativeUsdc)).toBe(
      getBaseNetworkConfig('sepolia').nativeUsdc,
    );
    expect(assertDebtAsset('mainnet', getBaseNetworkConfig('mainnet').nativeUsdc)).toBe(
      getBaseNetworkConfig('mainnet').nativeUsdc,
    );
    expect(() => assertFacilityAsset('sepolia', USDBC_ADDRESS)).toThrow('UNSUPPORTED_ASSET');
    expect(() => assertDebtAsset('mainnet', USDBC_ADDRESS)).toThrow('UNSUPPORTED_ASSET');
  });

  it('keeps system addresses and sequencer grace as explicit configuration', () => {
    expect(B20_SYSTEM_CONTRACTS).toMatchObject({
      b20Factory: '0xB20f000000000000000000000000000000000000',
      policyRegistry: '0x8453000000000000000000000000000000000002',
      activationRegistry: '0x8453000000000000000000000000000000000001',
    });
    expect(getBaseNetworkConfig('sepolia').sequencerGracePeriodSeconds).toBe(3600);
  });

  it('pins the official feed policy metadata and converts positive eight-decimal answers to WAD', () => {
    expect(CHAINLINK_FEED_HEARTBEAT_SECONDS).toBe(86_400);
    expect(CHAINLINK_FEED_DEVIATION_BPS).toBe(50);
    expect(chainlinkAnswerToWad(123_456_789n, 8)).toBe(1_234_567_890_000_000_000n);
    expect(() => chainlinkAnswerToWad(0n, 8)).toThrow('ORACLE_NON_POSITIVE');
    expect(() => chainlinkAnswerToWad(-1n, 8)).toThrow('ORACLE_NON_POSITIVE');
    expect(() => chainlinkAnswerToWad(123n, 18)).toThrow('ORACLE_DECIMALS');
  });
});
