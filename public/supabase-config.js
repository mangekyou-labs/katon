// ---------------------------------------------------------------------------
// Supabase configuration
// ---------------------------------------------------------------------------
// 1. Create a project at https://supabase.com
// 2. Project Settings -> API -> copy "Project URL" and the "anon public" key
// 3. Paste them below, then reload otc.html
//
// The anon key is safe to expose in the browser; access is governed by the
// Row Level Security (RLS) policies on the `orders` table (see README.md), and
// `orders` must be added to the `supabase_realtime` publication so new offers
// and status changes stream live.
//
// There is NO sign-in: identity is the connected Stellar wallet address.
// Integrity comes from wallet signatures on each order and on accept/decline.
// ---------------------------------------------------------------------------

window.SUPABASE_URL = 'https://zaflldqvenbgfaxtzbjc.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InphZmxsZHF2ZW5iZ2ZheHR6YmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTc1MDAsImV4cCI6MjA5NzI5MzUwMH0._ICBXPBxuBkx39eCxeE5nRxD8D4__TE2_pQsyurs6mk';
