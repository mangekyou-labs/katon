import { describe, expect, it } from 'vitest';

import { bytes32Identifier } from '../packages/flare-core/src/fccEnvelope';
import { buildFccInstructionAction } from '../packages/flare-core/src/fccInstruction';

const ENVELOPE = `0x${'ab'.repeat(96)}`;
const INSTRUCTION_ID = `0x${'11'.repeat(32)}`;

describe('FCC rehearsal instruction builder', () => {
  it('wraps an envelope in the scaffold Action/DataFixed wire format', () => {
    const action = buildFccInstructionAction({
      instructionId: INSTRUCTION_ID,
      teeId: `0x${'22'.repeat(32)}`,
      opType: 'RFQ',
      command: 'CREATE',
      envelopeEncoded: ENVELOPE,
      timestamp: 1_700_000_000,
      rewardEpochId: 42,
    });

    expect(action.data.id).toBe(INSTRUCTION_ID);
    expect(action.data.type).toBe('instruction');
    expect(action.data.submissionTag).toBe('submit');
    expect(action.additionalVariableMessages).toEqual([]);
    expect(action.timestamps).toEqual([]);
    expect(action.additionalActionData).toBe('0x');
    expect(action.signatures).toEqual([]);

    const stripped = action.data.message.slice(2);
    expect(stripped).toMatch(/^[0-9a-f]+$/);
    const fixed = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(stripped.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16)),
      ),
    ) as Record<string, unknown>;
    expect(fixed).toEqual({
      instructionId: INSTRUCTION_ID,
      teeId: `0x${'22'.repeat(32)}`,
      timestamp: 1_700_000_000,
      rewardEpochId: 42,
      opType: bytes32Identifier('RFQ'),
      opCommand: bytes32Identifier('CREATE'),
      cosigners: [],
      cosignersThreshold: 0,
      originalMessage: ENVELOPE,
      additionalFixedMessage: '0x',
    });
  });

  it('rejects identifiers that are not valid bytes32 words', () => {
    expect(() =>
      buildFccInstructionAction({
        instructionId: INSTRUCTION_ID,
        teeId: `0x${'22'.repeat(32)}`,
        opType: 'RFQ',
        command: 'CREATE',
        envelopeEncoded: 'not-hex',
      }),
    ).toThrow('FCC_INSTRUCTION_ENVELOPE');
  });
});
