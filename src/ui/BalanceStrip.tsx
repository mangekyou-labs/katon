// Balance chips for the intent-layer topbar (spec §4.5). Purely
// presentational — data comes in from useBalances, no fetching here. One chip
// per allow-listed token; an absent trustline renders 0 (BalanceMap omits it).
// A null map means the last fetch failed — unknown ≠ zero, so it says
// "unavailable" instead of rendering 0s. An unfunded account just reads 0s: the
// strip carries no warning, because the Ticket's send gate is what actually
// stops an offer you cannot cover.
//
// Class names (CSS lands later in public/intent.css): bal-strip,
// bal-strip__chip, bal-strip__token, bal-strip__amount, bal-strip__note.

import { balanceOf, fmtBalance } from '../core/balances';
import type { BalanceMap } from '../core/balances';
import { TOKENS } from '../core/tokens';

export interface BalanceStripProps {
  balances: BalanceMap | null;
  loading: boolean;
}

export function BalanceStrip({ balances, loading }: BalanceStripProps) {
  if (loading) {
    return (
      <div className="bal-strip">
        <span className="bal-strip__note">Loading balances…</span>
      </div>
    );
  }
  if (balances === null) {
    return (
      <div className="bal-strip">
        <span className="bal-strip__note">Balances unavailable</span>
      </div>
    );
  }
  return (
    <div className="bal-strip">
      {TOKENS.map((t) => (
        <span key={t.value} className="bal-strip__chip">
          <span className="bal-strip__token">{t.label}</span>{' '}
          <span className="bal-strip__amount">{fmtBalance(balanceOf(balances, t.value))}</span>
        </span>
      ))}
    </div>
  );
}
