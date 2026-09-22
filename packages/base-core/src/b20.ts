import type { Address } from './network';

export const B20_SYSTEM_CONTRACTS = {
  b20Factory: '0xB20f000000000000000000000000000000000000',
  policyRegistry: '0x8453000000000000000000000000000000000002',
  activationRegistry: '0x8453000000000000000000000000000000000001',
} as const satisfies Record<'b20Factory' | 'policyRegistry' | 'activationRegistry', Address>;
