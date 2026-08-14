import { describe, expect, it } from 'vitest';

import { readAccessDecision } from '../apps/flare-api/src/access';

describe('Flare API read access policy', () => {
  it('keeps anonymous aggregate reads public but requires auth for wallet-scoped reads', () => {
    expect(readAccessDecision('', true, false)).toBe('public');
    expect(readAccessDecision('0xwallet', false, false)).toBe('public');
    expect(readAccessDecision('0xwallet', true, false)).toBe('authenticated');
    expect(readAccessDecision('0xwallet', true, true)).toBe('authenticated');
  });

  it('treats an explicit bot token as authenticated even in local demo mode', () => {
    expect(readAccessDecision('0xwallet', false, true)).toBe('authenticated');
  });
});
