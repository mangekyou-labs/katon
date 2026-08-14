// Single #toast element, same contract as vanilla: base styles live on the ID
// in styles.css, `show ok|err` classes drive visibility/kind, 4200ms timer.
// The message stays rendered after hiding so the fade-out doesn't snap blank.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export type ToastKind = '' | 'ok' | 'err';
type ToastFn = (msg: string, kind?: ToastKind) => void;

const Ctx = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ msg: string; kind: ToastKind; show: boolean }>({
    msg: '', kind: '', show: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<ToastFn>((msg, kind = '') => {
    setState({ msg, kind, show: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState((s) => ({ ...s, show: false })), 4200);
  }, []);

  return (
    <Ctx.Provider value={toast}>
      {children}
      <div id="toast" className={state.show ? `show ${state.kind}` : ''}>{state.msg}</div>
    </Ctx.Provider>
  );
}

export const useToast = (): ToastFn => useContext(Ctx);

/** vanilla `err?.message || fallback` — but Supabase errors are plain objects, not Error */
export function errMsg(e: unknown, fallback: string): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof m === 'string' && m) return m;
  if (typeof e === 'string' && e) return e;
  return fallback;
}
