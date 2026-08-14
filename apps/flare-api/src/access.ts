export type ReadAccessDecision = 'public' | 'authenticated';

export function readAccessDecision(wallet: string, authRequired: boolean, hasToken: boolean): ReadAccessDecision {
  return wallet.trim() && (authRequired || hasToken) ? 'authenticated' : 'public';
}
