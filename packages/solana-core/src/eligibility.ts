import { parseAtomic } from './amounts';
import { assertSupportedOutput, checkMintAgainstRegistry } from './registry';
import type { AssetRegistryEntry, EligibilityResult, MintAccountSnapshot } from './types';

export interface EligibilityInput {
  readonly entry?: AssetRegistryEntry;
  readonly mint?: MintAccountSnapshot;
  readonly walletBalanceAtomic: string;
  readonly requestedAmountAtomic?: string;
  readonly outputMint: string;
  readonly nowMs?: number;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const checkedAtMs = input.nowMs ?? Date.now();
  if (!input.entry || !input.mint) {
    return { status: 'unknown', code: 'unknown', message: 'asset registry or mint account is unavailable', checkedAtMs };
  }
  const registryCheck = checkMintAgainstRegistry(input.entry, input.mint);
  if (!registryCheck.ok) {
    const status = registryCheck.code === 'paused' ? 'ineligible' : 'unknown';
    const code = registryCheck.code === 'paused' ? 'paused_asset' : registryCheck.code === 'unknown_extension' ? 'unsupported_extension' : registryCheck.code === 'fingerprint_mismatch' || registryCheck.code === 'hook_mismatch' ? 'changed_extension' : registryCheck.code === 'issuer_authority_mismatch' || registryCheck.code === 'issuer_program_mismatch' || registryCheck.code === 'jit_capability_mismatch' ? 'issuer_mismatch' : 'policy_failure';
    return { status, code, message: registryCheck.message, asset: input.entry, checkedAtMs };
  }
  try {
    assertSupportedOutput(input.entry, input.outputMint);
  } catch (error) {
    return { status: 'ineligible', code: 'unsupported_output', message: error instanceof Error ? error.message : 'unsupported output', asset: input.entry, checkedAtMs };
  }
  if (!input.entry.enabled) {
    return { status: 'ineligible', code: 'policy_failure', message: 'asset is not enabled by policy', asset: input.entry, checkedAtMs };
  }
  if (input.entry.referenceState === 'closed') {
    return { status: 'action_required', code: 'stale_reference', message: 'issuer market session is closed', asset: input.entry, checkedAtMs };
  }
  if (input.entry.referenceState === 'stale' || input.entry.referenceState === 'unknown') {
    return { status: 'unknown', code: 'stale_reference', message: 'reference price is stale or unavailable', asset: input.entry, checkedAtMs };
  }
  try {
    const balance = parseAtomic(input.walletBalanceAtomic, 'wallet balance');
    if (input.requestedAmountAtomic !== undefined && parseAtomic(input.requestedAmountAtomic, 'requested amount') <= 0n) {
      return { status: 'ineligible', code: 'malformed_quote', message: 'requested exact input must be greater than zero', asset: input.entry, balanceAtomic: input.walletBalanceAtomic, checkedAtMs };
    }
    if (balance <= 0n) {
      return { status: 'action_required', code: 'insufficient_balance', message: 'wallet has no spendable stock balance', asset: input.entry, balanceAtomic: input.walletBalanceAtomic, checkedAtMs };
    }
    if (input.requestedAmountAtomic !== undefined && parseAtomic(input.requestedAmountAtomic, 'requested amount') > balance) {
      return { status: 'action_required', code: 'insufficient_balance', message: 'wallet balance is smaller than the requested exact input', asset: input.entry, balanceAtomic: input.walletBalanceAtomic, checkedAtMs };
    }
  } catch (error) {
    return { status: 'unknown', code: 'unknown', message: error instanceof Error ? error.message : 'invalid wallet balance', asset: input.entry, checkedAtMs };
  }
  return { status: 'eligible', message: 'asset and wallet passed issuer and on-chain preflight', asset: input.entry, balanceAtomic: input.walletBalanceAtomic, checkedAtMs };
}
