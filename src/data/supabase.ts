import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config';

// Anon key, no auth — coordination state only. Reads are public (accepted for
// the Testnet MVP); integrity lives in wallet signatures + the on-chain fill.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
