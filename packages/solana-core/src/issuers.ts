import { parseAtomic } from './amounts';
import { assertSupportedOutput, checkMintAgainstRegistry } from './registry';
import type { AssetRegistryEntry, EligibilityResult, MintAccountSnapshot, QuoteCandidate, SettlementRoute } from './types';

export interface IssuerPreflightContext {
  readonly wallet: string;
  readonly walletBalanceAtomic: string;
  readonly requestedAmountAtomic?: string;
  readonly outputMint?: string;
  readonly nowMs?: number;
}

export interface IssuerAdapter {
  readonly issuer: AssetRegistryEntry['issuer'];
  readonly settlementRoute: SettlementRoute;
  preflight(asset: AssetRegistryEntry, mint: MintAccountSnapshot, context: IssuerPreflightContext): EligibilityResult;
}

abstract class RegistryIssuerAdapter implements IssuerAdapter {
  abstract readonly issuer: AssetRegistryEntry['issuer'];
  abstract readonly settlementRoute: SettlementRoute;

  preflight(asset: AssetRegistryEntry, mint: MintAccountSnapshot, context: IssuerPreflightContext): EligibilityResult {
    const checkedAtMs = context.nowMs ?? Date.now();
    if (asset.issuer !== this.issuer) return { status: 'unknown', code: 'policy_failure', message: 'issuer adapter does not match registry issuer', asset, checkedAtMs };
    const check = checkMintAgainstRegistry(asset, mint);
    if (!check.ok) return { status: check.code === 'paused' ? 'ineligible' : 'unknown', code: check.code === 'unknown_extension' ? 'unsupported_extension' : check.code === 'paused' ? 'paused_asset' : check.code === 'issuer_authority_mismatch' || check.code === 'issuer_program_mismatch' || check.code === 'jit_capability_mismatch' ? 'issuer_mismatch' : 'changed_extension', message: check.message, asset, checkedAtMs };
    if (!asset.enabled) {
      const message = asset.issuer === 'ondo' ? 'Managed Route not enabled' : 'asset is disabled by issuer policy';
      return { status: 'ineligible', code: 'policy_failure', message, asset, checkedAtMs };
    }
    if (context.outputMint !== undefined) {
      try {
        assertSupportedOutput(asset, context.outputMint);
      } catch (error) {
        return { status: 'ineligible', code: 'unsupported_output', message: error instanceof Error ? error.message : 'output mint is not supported', asset, checkedAtMs };
      }
    }
    if (asset.referenceState === 'closed') return { status: 'action_required', code: 'stale_reference', message: 'issuer market session is closed', asset, checkedAtMs };
    if (asset.referenceState !== 'open') return { status: 'unknown', code: 'stale_reference', message: 'issuer reference/session is not executable', asset, checkedAtMs };
    try {
      const balance = parseAtomic(context.walletBalanceAtomic, 'wallet balance');
      if (balance <= 0n) return { status: 'action_required', code: 'insufficient_balance', message: 'wallet has no spendable stock balance', asset, balanceAtomic: context.walletBalanceAtomic, checkedAtMs };
      if (context.requestedAmountAtomic !== undefined) {
        const requested = parseAtomic(context.requestedAmountAtomic, 'requested amount');
        if (requested <= 0n) return { status: 'ineligible', code: 'malformed_quote', message: 'requested exact input must be greater than zero', asset, balanceAtomic: context.walletBalanceAtomic, checkedAtMs };
        if (requested > balance) return { status: 'action_required', code: 'insufficient_balance', message: 'wallet balance is smaller than the requested exact input', asset, balanceAtomic: context.walletBalanceAtomic, checkedAtMs };
      }
    } catch (error) {
      return { status: 'unknown', code: 'unknown', message: error instanceof Error ? error.message : 'invalid wallet balance', asset, checkedAtMs };
    }
    return { status: 'eligible', message: `${this.issuer} issuer preflight passed`, asset, balanceAtomic: context.walletBalanceAtomic, checkedAtMs };
  }
}

/** xStocks metadata and policy are deliberately not shared with Ondo JIT. */
export class XStocksIssuerAdapter extends RegistryIssuerAdapter {
  readonly issuer = 'xstocks' as const;
  readonly settlementRoute = 'generic-spl' as const;
}

/** Ondo routes carry issuer-managed JIT accounts; generic SPL routes are rejected. */
export class OndoIssuerAdapter extends RegistryIssuerAdapter {
  readonly issuer = 'ondo' as const;
  readonly settlementRoute = 'ondo-managed' as const;
}

export function routeAllowedForIssuer(issuer: AssetRegistryEntry['issuer'], candidate: Pick<QuoteCandidate, 'settlementRoute'>): boolean {
  return adapterForIssuer(issuer).settlementRoute === candidate.settlementRoute;
}

export function adapterForIssuer(issuer: AssetRegistryEntry['issuer']): IssuerAdapter {
  return issuer === 'xstocks' ? new XStocksIssuerAdapter() : new OndoIssuerAdapter();
}
