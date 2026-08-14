import { bytes32Identifier, type Hex } from './fccEnvelope';

export interface FccInstructionActionInput {
  readonly instructionId: Hex;
  readonly teeId: Hex;
  readonly opType: string;
  readonly command: string;
  readonly envelopeEncoded: string;
  readonly timestamp?: number;
  readonly rewardEpochId?: number;
}

export interface FccScaffoldAction {
  readonly data: {
    readonly id: Hex;
    readonly type: 'instruction';
    readonly submissionTag: 'submit';
    readonly message: Hex;
  };
  readonly additionalVariableMessages: readonly string[];
  readonly timestamps: readonly number[];
  readonly additionalActionData: '0x';
  readonly signatures: readonly string[];
}

function hexEncode(value: string): string {
  return `0x${Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Wraps a sealed FCC recipient envelope in the tee-node scaffold wire format:
 * a POST /instruction body whose data.message is hex-encoded UTF-8 JSON
 * matching the DataFixed contract decoded by the Go handler.
 */
export function buildFccInstructionAction(input: FccInstructionActionInput): FccScaffoldAction {
  if (!/^0x[0-9a-fA-F]+$/.test(input.envelopeEncoded)) throw new Error('FCC_INSTRUCTION_ENVELOPE');
  const fixed = {
    instructionId: input.instructionId,
    teeId: input.teeId,
    timestamp: input.timestamp ?? 0,
    rewardEpochId: input.rewardEpochId ?? 0,
    opType: bytes32Identifier(input.opType),
    opCommand: bytes32Identifier(input.command),
    cosigners: [] as const,
    cosignersThreshold: 0,
    originalMessage: input.envelopeEncoded,
    additionalFixedMessage: '0x',
  };
  return {
    data: {
      id: input.instructionId,
      type: 'instruction' as const,
      submissionTag: 'submit' as const,
      message: hexEncode(JSON.stringify(fixed)) as Hex,
    },
    additionalVariableMessages: [],
    timestamps: [],
    additionalActionData: '0x',
    signatures: [],
  };
}
