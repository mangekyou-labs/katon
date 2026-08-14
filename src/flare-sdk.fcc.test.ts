import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { FCC_INSTRUCTION_SENDER_ABI, buildDispatchConfidentialTransaction, buildSubmitFccResultTransaction } from '../packages/flare-sdk/src/fcc';

const from = '0x1000000000000000000000000000000000000001';
const sender = '0x2000000000000000000000000000000000000002';
const bytes32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;

describe('FCC wallet transaction construction', () => {
  it('builds a Coston2 three-TEE dispatch targeting only the configured sender', () => {
    const transaction = buildDispatchConfidentialTransaction({ from, instructionSender: sender, opType: 'RFQ', command: 'CREATE', actionId: bytes32('1'), envelope: `0x${'ab'.repeat(96)}`, expiry: 1_800_000_000 });
    expect(transaction).toMatchObject({ from, to: sender, chainId: 114, value: 0n });
    const decoded = decodeFunctionData({ abi: FCC_INSTRUCTION_SENDER_ABI, data: transaction.data });
    expect(decoded.functionName).toBe('dispatchConfidential');
    expect(decoded.args?.[5]).toBe(3n);
  });

  it('attaches the Coston2 instruction fee when provided', () => {
    const transaction = buildDispatchConfidentialTransaction({
      from, instructionSender: sender, opType: 'MATCH', command: 'FINALIZE',
      actionId: bytes32('1'), envelope: `0x${'ab'.repeat(96)}`, expiry: 1_800_000_000, value: 1_000_000n,
    });
    expect(transaction.value).toBe(1_000_000n);
  });

  it('builds a seller relay transaction with the signed ActionResult unchanged', () => {
    const result = { id: bytes32('2'), submissionTag: 'trust-rfq', status: 1, data: bytes32('3'), signature: `0x${'44'.repeat(65)}` as `0x${string}` };
    const transaction = buildSubmitFccResultTransaction({ from, instructionSender: sender, result });
    const decoded = decodeFunctionData({ abi: FCC_INSTRUCTION_SENDER_ABI, data: transaction.data });
    expect(decoded.functionName).toBe('submitFccResult');
    expect(decoded.args).toEqual([result.id, result.data, result.submissionTag, result.status, result.signature]);
  });

  it('rejects malformed envelopes and result signatures before opening MetaMask', () => {
    expect(() => buildDispatchConfidentialTransaction({ from, instructionSender: sender, opType: 'RFQ', command: 'CREATE', actionId: bytes32('1'), envelope: '0x', expiry: 1_800_000_000 })).toThrow('FCC_ENVELOPE');
    expect(() => buildSubmitFccResultTransaction({ from, instructionSender: sender, result: { id: bytes32('2'), submissionTag: 'trust-rfq', status: 1, data: bytes32('3'), signature: '0x12' } })).toThrow('FCC_RESULT_SIGNATURE');
  });
});
