// The app's ONE nav control: a glass capsule in the topbar (top-right) that
// names the active section, and a menu that unfolds beneath it listing all of
// them. Generic over N options; the desk passes three. The menu only switches
// which .panel is active — panels stay mounted in App, so drafts and list state
// survive.

import { useEffect, useRef, useState } from 'react';

export interface SectionOption<T extends string> {
  id: T;
  label: string;
  /** small glyph shown in the pill and the option row, e.g. '+', '↓', '↑' */
  glyph: string;
  /** pending count badge; omit for sections without one */
  count?: number;
}

interface SectionSheetProps<T extends string> {
  options: readonly SectionOption<T>[];
  active: T;
  onSelect: (id: T) => void;
}

export function SectionSheet<T extends string>({ options, active, onSelect }: SectionSheetProps<T>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const activeOpt = options.find((o) => o.id === active) ?? options[0];
  const pending = options.reduce((n, o) => n + (o.count ?? 0), 0);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === 'Tab') {
        // focus trap: cycle within the sheet's option buttons. Also catch the
        // case where focus fell OUT of the panel (e.g. a click on the panel's
        // padding blurs to <body>) — otherwise Tab would walk the obscured
        // page behind the aria-modal dialog.
        const els = panelRef.current?.querySelectorAll<HTMLButtonElement>('.sheet__option');
        if (!els || els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        const activeEl = document.activeElement;
        if (!panelRef.current?.contains(activeEl)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && activeEl === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLButtonElement>('.sheet__option.is-active')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <div className={open ? 'section-nav is-open' : 'section-nav'}>
      <button
        ref={triggerRef}
        type="button"
        className="section-fab"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="section-fab__glyph" aria-hidden="true">{activeOpt.glyph}</span>
        <span className="section-fab__label">{activeOpt.label}</span>
        {pending > 0 ? <span className="section-fab__count">{pending}</span> : null}
        <span className="section-fab__chevron" aria-hidden="true" />
      </button>

      {open ? (
        <>
          <div className="sheet__backdrop" onClick={close} />
          <div ref={panelRef} className="sheet__panel" role="dialog" aria-modal="true" aria-label="Desk sections">
            {options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                // the stagger is the animation's whole trick: each row rides in a
                // beat after the one above it. Index-driven, so it stays right
                // for any N options.
                style={{ '--row': i } as React.CSSProperties}
                className={o.id === active ? 'sheet__option is-active' : 'sheet__option'}
                onClick={() => { onSelect(o.id); close(); }}
              >
                <span className="sheet__option-glyph" aria-hidden="true">{o.glyph}</span>
                {o.label}
                {o.count !== undefined ? <span className="sheet__option-count">{o.count}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
