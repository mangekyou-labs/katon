// ---------------------------------------------------------------------------
// Runtime configuration — read from window.* set by /supabase-config.js and
// /otc-config.js (plain scripts in public/, loaded before this module).
// ---------------------------------------------------------------------------
// Deliberately NOT import.meta.env: keeping config out of the bundle means a
// Testnet reset (new OTC_CONTRACT_ID) stays a one-file edit on the deployed
// site rather than a rebuild — the workflow CLAUDE.md and README document.
//
// This is the only module allowed to read window config. src/core/* stays pure.

declare global {
  interface Window {
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    RPC_URL?: string;
    HORIZON_URL?: string;
    NETWORK_PASSPHRASE?: string;
    OTC_CONTRACT_ID?: string;
    REFLECTOR_ORACLE_ID?: string;
  }
}

const w: Window | Record<string, never> = typeof window === 'undefined' ? {} : window;

export const SUPABASE_URL = w.SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = w.SUPABASE_ANON_KEY ?? '';

export const RPC_URL = w.RPC_URL || 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = w.HORIZON_URL || 'https://horizon-testnet.stellar.org';
export const PASSPHRASE = w.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
export const OTC_CONTRACT_ID = (w.OTC_CONTRACT_ID || '').trim();
export const settlementEnabled = /^C[A-Z2-7]{55}$/.test(OTC_CONTRACT_ID);

// Reflector oracle for the ticket's reference fair-price suggestion. Empty/invalid
// → the suggestion is silently off (never blocks the form). Not on any signed path.
export const REFLECTOR_ORACLE_ID = (w.REFLECTOR_ORACLE_ID || '').trim();
export const fairPriceEnabled = /^C[A-Z2-7]{55}$/.test(REFLECTOR_ORACLE_ID);

export const EXPLORER = 'https://stellar.expert/explorer/testnet';
