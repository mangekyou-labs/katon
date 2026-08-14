// Pairs panel (spec §4.1): the taker's manual pair-interest toggles. One row
// per allow-listed pair; toggle on = discoverable for private offers on that
// pair (both directions), toggle off = row deleted. Load/toggle failures are
// toasted by useIntents through onError.
//
// Presentation (2026-07-15): the Incoming panel's LEFT column stacks a small
// info bar (`.pairs-note`, the explainer copy) on top of this glass capsule
// (`.pairs-glass`); the offers own the RIGHT column. Collapsed the capsule is
// just its title button; clicking it expands the toggle rows. `.pairs-zone` is
// `display: contents`, so BOTH children are direct grid items of the Incoming
// panel (see intent.css). The rows stay MOUNTED while collapsed so the height
// transition has something to animate; `inert` keeps the collapsed toggles
// unfocusable and unclickable.

import { useCallback, useState } from 'react';
import { ALL_PAIRS } from '../core/pairs';
import { useIntents } from '../data/useIntents';
import { useToast } from './Toast';

export interface PairsPanelProps {
  address: string;
}

export function PairsPanel({ address }: PairsPanelProps) {
  const toast = useToast();
  const onError = useCallback((m: string) => toast(m, 'err'), [toast]);
  const { has, toggle, busyKey } = useIntents(address, onError);
  const [open, setOpen] = useState(false);

  return (
    <div className="pairs-zone">
      <section className={open ? 'pairs-glass is-open' : 'pairs-glass'}>
        <button type="button" className="pairs-glass__trigger" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}>
          <span className="pairs-glass__title">Pairs you're watching</span>
          <span className="pairs-glass__chev" aria-hidden="true" />
        </button>

        <div className="pairs-glass__reveal" inert={!open || undefined}>
          <div className="pairs-glass__rows">
            {ALL_PAIRS.map((p) => {
              const on = has(p.key);
              return (
                <div key={p.key} className="pairs-row">
                  <span className="pairs-row__label">{p.label}</span>
                  <button type="button" role="switch" aria-checked={on}
                    aria-label={`Discoverable for ${p.label}`}
                    className={on ? 'pairs-toggle is-on' : 'pairs-toggle'}
                    disabled={busyKey === p.key}
                    onClick={() => void toggle(p.key)}>
                    <span className="pairs-toggle__thumb" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* The explainer, authored as phrase spans; `.pairs-hero` now flows them
          inline as one sentence (a ::after space restores the word gaps). Screen
          readers read one sentence — the spans carry no roles. */}
      <aside className="pairs-note">
        <p className="pairs-hero">
          <span>Toggle a pair on</span>
          <span>to become</span>
          <span>discoverable.</span>
          <span>Makers can send</span>
          <span>you private offers</span>
          <span>on it, in both</span>
          <span>directions.</span>
        </p>
      </aside>
    </div>
  );
}
