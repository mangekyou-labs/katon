import { createHash, createHmac } from 'node:crypto';
import { keccak256, stringToHex } from 'viem';

const RFQ_ID = keccak256(stringToHex('KATON_BASE_QA_HEADED_RFQ_V1'));

export function buildBaseQaSeed(manifest, blockTimestamp) {
  if (manifest?.environment !== 'anvil' || manifest.chainId !== 8_453 || manifest.forkQa !== true) throw new Error('BASE_QA_SEED_MANIFEST');
  const adapter = manifest.adapters?.[0];
  const operator = requiredAddress(manifest.roles?.operator, 'operator');
  const nativeUsdc = requiredAddress(manifest.nativeUsdc, 'nativeUsdc');
  const mockB20 = requiredAddress(manifest.addresses?.mockB20, 'mockB20');
  if (!adapter || !/^0x[0-9a-fA-F]{64}$/.test(adapter.marketId ?? '')) throw new Error('BASE_QA_SEED_MARKET');
  if (typeof blockTimestamp !== 'bigint' || blockTimestamp <= 0n) throw new Error('BASE_QA_SEED_TIME');
  return {
    rfqId: RFQ_ID,
    borrower: operator,
    debtAsset: nativeUsdc,
    collateralAsset: mockB20,
    marketId: adapter.marketId,
    repayAssets: '10000000',
    minCollateralOut: '10000000',
    deadline: (blockTimestamp + 3_600n).toString(10),
    opportunityKey: 'base-mainnet-fork-headed-rfq-v1',
  };
}

export function createBaseQaSeedHeaders(secret, timestamp, body) {
  if (!secret || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('BASE_QA_SEED_CREDENTIALS');
  const path = '/v1/liquidations';
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = `POST\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = `0x${createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')}`;
  return {
    authorization: `Katon-HMAC base-qa-keeper:${signature}`,
    'x-katon-key-id': 'base-qa-keeper',
    'x-katon-timestamp': String(timestamp),
    'x-katon-body-sha256': `0x${bodyHash}`,
    'x-katon-signature': signature,
  };
}

function requiredAddress(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`BASE_QA_SEED_ADDRESS:${field}`);
  return value;
}
