export const CONTRACTS_PACKAGE_VERSION = '0.1.0';

export const COSTON2_DEPLOYMENT = {
  chainId: 114,
  candidate: 'transparent-proxy-v1',
  eligibilityRegistry: '0x9D1Ce80e382102674CEf721C674CD6f205cD0DcD',
  router: '0x7fA1817951dE405a0c466696052cF50Eba409333',
  settlement: '0xD19daEB89ad906557e4AD4FE7D23068B49BD6F2F',
  instructionSender: '0xC018A20d1694ed588320758529bc55b56e2beA60',
  facilityAggregator: '0x0de3d0392C4F0e06F4f50D24Cb98Bd85bFE41446',
  navProofRegistry: '0x1de19aF3FD9B609F6087a0972442895B2d6DE2AE',
  ftsoRiskGuard: '0xcfC765f1A6B9eEb28Cb7017A4F8E05f05b0fF0a8',
} as const;

/**
 * Testnet-only assets and eligibility snapshot used by the deployed typed-swap
 * fixture. Keep these beside the deployment manifest so browser transactions
 * cannot silently drift back to an older demo address set.
 */
export const COSTON2_MOCK_ASSETS = {
  chainId: 114,
  rwa: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f',
  usdx: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0',
  source: '0x29713643c62c6743a5bf68e39ac1de8eaec0bc97',
  policyId: '0xfce7648109ab89be432fa46626fe3e28945504427907a6705d5a78b489343e40',
  policyRole: 1n,
  issuerReference: '0x1989e753f42feddc4e2384444ec868a7b2b7acb30922c48fef7a6d4c14379971',
} as const;

/** Historical direct deployment retained for mock-funding and migration tooling. */
export const COSTON2_LEGACY_DIRECT_DEPLOYMENT = {
  chainId: 114,
  eligibilityRegistry: '0x040b49f3408267fbf95f048e6bb7a5b09e830fac',
  router: '0x593095709e16275cc0b8aa0ef908fd13d693c36c',
  settlement: '0x6dc51b3ef4eea9d7b0609381491e00abf3720674',
  instructionSender: '0x6b97db10f053e384bd6d4acb22d3f5851040310',
  facilityAggregator: '0x9f120294475039166d665d8f226737acd7b96c7d',
  navProofRegistry: '0x792d6e3ecd9541bcf7bf31273f42bf41b758b02a',
  ftsoRiskGuard: '0xe1ca72b7397c361c6fc4100fa33b999681205094',
} as const;
