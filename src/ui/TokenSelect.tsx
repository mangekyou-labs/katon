// The hero's token picker: the token CODE is the control, at display size,
// flanking the swap orb. A native <select> cannot be typeset at 44px with a
// rotating chevron, so this is a custom listbox — but it keeps the native
// select semantics that matter: it renders a real <select> for the no-JS /
// screen-reader path and mirrors every choice into it, so `value`/`onChange`
// stay the single source of truth and nothing here holds selection state.

import { useEffect, useRef, useState } from 'react';
import { tokenLabel, type TokenOption } from '../core/tokens';

/** Display names, keyed by the token CODE (not the full CODE:ISSUER value). */
const TOKEN_NAMES: Record<string, string> = {
  XLM: 'Stellar Lumens',
  USDC: 'USD Coin',
};

export function TokenSelect({ id, value, options, disabled, label, onChange }: {
  id: string;
  value: string;
  options: TokenOption[];
  disabled?: boolean;
  /** accessible name — the visible label lives on the leg, not here */
  label: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  // Outside-click and Escape close it. Both listeners only exist while open, so
  // the three token pickers on the desk cost nothing at rest.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A disabled ticket (wallet prompt open) must not leave a menu hanging open.
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <span className={open ? 'tok is-open' : 'tok'} ref={root}>
      <select className="tok__native" id={id} aria-label={label} tabIndex={-1}
        value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>

      <button type="button" className="tok__trigger" aria-haspopup="listbox" aria-expanded={open}
        aria-label={label} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span className="tok__code">{tokenLabel(value)}</span>
        <svg className="tok__chev" width="15" height="9" viewBox="0 0 15 9" fill="none" aria-hidden="true">
          <path d="M1.5 1.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="tok__menu" role="listbox" aria-label={label}>
        {options.map((t) => {
          const active = t.value === value;
          return (
            <button key={t.value} type="button" role="option" aria-selected={active}
              className={active ? 'tok__opt is-active' : 'tok__opt'}
              onClick={() => { onChange(t.value); setOpen(false); }}>
              <span className="tok__opt-code">{t.label}</span>
              <span className="tok__opt-name">{TOKEN_NAMES[tokenLabel(t.value)] ?? ''}</span>
              <span className="tok__check" aria-hidden="true">✓</span>
            </button>
          );
        })}
      </div>
    </span>
  );
}
