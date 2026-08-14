import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { FccResultRelay, fccActionResultDigest, type FccActionResult } from '../packages/flare-core/src/fccRelay';

describe('FCC instruction/result relay', () => {
  it('maps FCC instruction IDs to logical actions and reaches a 2-of-3 route quorum', async () => {
    const accounts = [privateKeyToAccount(`0x${'11'.repeat(32)}`), privateKeyToAccount(`0x${'22'.repeat(32)}`), privateKeyToAccount(`0x${'33'.repeat(32)}`)];
    const instructionId = `0x${'aa'.repeat(32)}` as const;
    const logicalActionId = `0x${'bb'.repeat(32)}` as const;
    const data = `0x${'cc'.repeat(32)}` as const;
    const relay = new FccResultRelay();
    relay.bindInstruction({ instructionId, logicalActionId, selectedSigners: accounts.map((account) => account.address as `0x${string}`), expiry: 2_000 });
    const unsigned = { id: instructionId, submissionTag: 'trust-rfq', status: 1, data } as const;
    const signatures = await Promise.all(accounts.slice(0, 2).map((account) => account.signMessage({ message: { raw: fccActionResultDigest(114, unsigned) } })));
    const first = await relay.accept(114, { ...unsigned, signature: signatures[0] } as FccActionResult, 1_000);
    const second = await relay.accept(114, { ...unsigned, signature: signatures[1] } as FccActionResult, 1_000);
    expect(first.logicalActionId).toBe(logicalActionId);
    expect(second.ready).toBe(true);
  });

  it('rejects dissent and duplicate selected signers', async () => {
    const account = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const relay = new FccResultRelay();
    const instructionId = `0x${'dd'.repeat(32)}` as const;
    relay.bindInstruction({ instructionId, logicalActionId: `0x${'ee'.repeat(32)}`, selectedSigners: [account.address as `0x${string}`, `0x${'12'.repeat(20)}`, `0x${'13'.repeat(20)}`], expiry: 2_000 });
    const first = { id: instructionId, submissionTag: 'trust-rfq', status: 1, data: `0x${'01'.repeat(32)}` as const };
    const signature = await account.signMessage({ message: { raw: fccActionResultDigest(114, first) } });
    await relay.accept(114, { ...first, signature }, 1_000);
    await expect(Promise.resolve().then(() => relay.accept(114, { ...first, signature }, 1_000))).rejects.toThrow('TEE_RESULT_REPLAY');
    const dissent = { ...first, data: `0x${'02'.repeat(32)}` as const };
    const dissentSignature = await account.signMessage({ message: { raw: fccActionResultDigest(114, dissent) } });
    await expect(Promise.resolve().then(() => relay.accept(114, { ...dissent, signature: dissentSignature }, 1_000))).rejects.toThrow('TEE_RESULT_REPLAY');
  });

  it('rejects results presented for a chain other than Coston2', async () => {
    const account = privateKeyToAccount(`0x${'55'.repeat(32)}`);
    const relay = new FccResultRelay();
    const instructionId = `0x${'ef'.repeat(32)}` as const;
    relay.bindInstruction({ instructionId, logicalActionId: `0x${'f0'.repeat(32)}`, selectedSigners: [account.address as `0x${string}`, `0x${'14'.repeat(20)}`, `0x${'15'.repeat(20)}`], expiry: 2_000 });
    const unsigned = { id: instructionId, submissionTag: 'trust-rfq', status: 1, data: `0x${'03'.repeat(32)}` as const };
    const signature = await account.signMessage({ message: { raw: fccActionResultDigest(114, unsigned) } });
    await expect(relay.accept(1, { ...unsigned, signature }, 1_000)).rejects.toThrow('FCC_CHAIN_ID');
  });

  it('maps an official tee-node ActionResponse onto submitFccResult args', async () => {
    const { parseFccActionResponse } = await import('../packages/flare-core/src/fccRelay');
    const instructionId = `0x${'aa'.repeat(32)}`;
    const routeHash = '0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975';
    const signature = `0x${'44'.repeat(65)}`;
    expect(parseFccActionResponse({
      result: { id: instructionId, submissionTag: 'submit', status: 1, data: routeHash },
      signature,
    })).toEqual({
      id: instructionId,
      submissionTag: 'submit',
      status: 1,
      data: routeHash,
      signature,
    });
  });

  it('rejects official ActionResponses that are not a 32-byte MATCH hash', async () => {
    const { parseFccActionResponse } = await import('../packages/flare-core/src/fccRelay');
    const instructionId = `0x${'aa'.repeat(32)}`;
    const signature = `0x${'44'.repeat(65)}`;
    expect(() => parseFccActionResponse({
      result: { id: instructionId, submissionTag: 'submit', status: 1, data: '0x7b226163636570746564223a747275657d' },
      signature,
    })).toThrow('RESULT_SCHEMA');
    expect(() => parseFccActionResponse({
      result: { id: instructionId, submissionTag: 'submit', status: 0, data: `0x${'11'.repeat(32)}`, log: 'error' },
      signature,
    })).toThrow('RESULT_STATUS');
  });
});
