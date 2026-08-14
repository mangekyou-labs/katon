import { describe, expect, it } from 'vitest';

describe('recipient buy-token delta after confidential settle', () => {
  const gross = 1_000n * 10n ** 18n;
  const net = 995n * 10n ** 18n;
  const recipient = '0xeD37FD0d6F0f69236E7472B36796e133D20EcC32';
  const other = '0x00000000000000000000000000000000000000c2';

  it('counts fee plus net when the recipient is also the fee recipient', async () => {
    const { expectedRecipientBuyTokenDelta } = await import('../packages/flare-core/src/fccSettle');
    expect(expectedRecipientBuyTokenDelta({
      grossOutput: gross,
      netOutput: net,
      recipient,
      feeRecipient: recipient,
    })).toBe(gross);
  });

  it('counts only net when the fee is sent to a different address', async () => {
    const { expectedRecipientBuyTokenDelta } = await import('../packages/flare-core/src/fccSettle');
    expect(expectedRecipientBuyTokenDelta({
      grossOutput: gross,
      netOutput: net,
      recipient,
      feeRecipient: other,
    })).toBe(net);
  });
});
