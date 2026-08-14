export const ISOLATED_COSTON2_FCC_ROUTER = '0xb136b8a143bF358Ae7976ED558BBB054fd13faE9';
export const BROWSER_COSTON2_PROXY_ROUTER = '0x7fA1817951dE405a0c466696052cF50Eba409333';
export const LIVE_FCC_EXTENSION_ID = 66283;
const FAKE_D9 = `0x${'d9'.repeat(32)}`.toLowerCase();
const DUMMY_GOLDEN = '0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975';

export interface LiveFccE2eEvidence {
  readonly router: string;
  readonly extensionId: number;
  readonly instructionSender: string;
  readonly dispatchHash: string;
  readonly actionId: string;
  readonly routeHash: string;
  readonly swapHash: string;
}

function isHex32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function rejectFake(label: string, value: string): void {
  if (value.toLowerCase() === FAKE_D9) throw new Error(`FAKE_D9_HASH:${label}`);
}

export function assertLiveFccE2eEvidence(evidence: LiveFccE2eEvidence): LiveFccE2eEvidence {
  rejectFake('swap', evidence.swapHash);
  rejectFake('dispatch', evidence.dispatchHash);
  rejectFake('route', evidence.routeHash);
  rejectFake('action', evidence.actionId);
  if (evidence.routeHash.toLowerCase() === DUMMY_GOLDEN) throw new Error('DUMMY_GOLDEN_ROUTE');
  if (evidence.router.toLowerCase() === BROWSER_COSTON2_PROXY_ROUTER.toLowerCase()) throw new Error('BROWSER_PROXY_ROUTER');
  if (evidence.router.toLowerCase() !== ISOLATED_COSTON2_FCC_ROUTER.toLowerCase()) throw new Error('WRONG_ROUTER');
  if (evidence.extensionId !== LIVE_FCC_EXTENSION_ID) throw new Error('WRONG_EXTENSION');
  for (const [label, value] of [
    ['dispatch', evidence.dispatchHash],
    ['action', evidence.actionId],
    ['route', evidence.routeHash],
    ['swap', evidence.swapHash],
  ] as const) {
    if (!isHex32(value)) throw new Error(`HASH_FORMAT:${label}`);
  }
  return evidence;
}

export function resolveSettlementRouter(
  runtime: { readonly __FLARE_ROUTER__?: string },
  fallback: string,
): string {
  return runtime.__FLARE_ROUTER__ ?? fallback;
}

export function liveFccProofRows(evidence: LiveFccE2eEvidence): readonly [string, string][] {
  return [
    ['Router', evidence.router],
    ['Extension', String(evidence.extensionId)],
    ['Action', evidence.actionId],
    ['Route hash', evidence.routeHash],
    ['Dispatch', evidence.dispatchHash],
    ['Swap', evidence.swapHash],
  ];
}
