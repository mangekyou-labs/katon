import { encodeFunctionData, getAddress, keccak256, type Address, type Hex } from 'viem';

import { bytes32Identifier } from '../../flare-core/src/fccEnvelope';
import type { UnsignedWalletTransaction } from './wallet';

export const FCC_INSTRUCTION_SENDER_ABI = [
  { type: 'function', name: 'dispatchConfidential', stateMutability: 'payable', inputs: [
    { name: 'opType', type: 'bytes32' }, { name: 'command', type: 'bytes32' }, { name: 'actionId', type: 'bytes32' },
    { name: 'payloadCommitment', type: 'bytes32' }, { name: 'message', type: 'bytes' }, { name: 'teeCount', type: 'uint256' }, { name: 'expiry', type: 'uint64' },
  ], outputs: [{ name: 'instructionId', type: 'bytes32' }] },
  { type: 'function', name: 'submitFccResult', stateMutability: 'nonpayable', inputs: [
    { name: 'instructionId', type: 'bytes32' }, { name: 'resultData', type: 'bytes' }, { name: 'submissionTag', type: 'string' }, { name: 'status', type: 'uint8' }, { name: 'signature', type: 'bytes' },
  ], outputs: [] },
] as const;

export interface DispatchConfidentialInput {
  readonly from: Address | string;
  readonly instructionSender: Address | string;
  readonly opType: string | Hex;
  readonly command: string | Hex;
  readonly actionId: Hex;
  readonly envelope: Hex;
  readonly expiry: number | bigint;
  readonly value?: bigint;
}

export interface FccResultInput {
  readonly id: Hex;
  readonly submissionTag: string;
  readonly status: number;
  readonly data: Hex;
  readonly signature: Hex;
}

export function buildDispatchConfidentialTransaction(input: DispatchConfidentialInput): UnsignedWalletTransaction {
  const from = getAddress(input.from); const to = getAddress(input.instructionSender);
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.actionId)) throw new Error('FCC_ACTION_ID');
  if (!/^0x[0-9a-fA-F]{2,}$/.test(input.envelope) || input.envelope.length % 2 !== 0) throw new Error('FCC_ENVELOPE');
  if (!Number.isSafeInteger(Number(input.expiry)) || Number(input.expiry) <= 0) throw new Error('FCC_EXPIRY');
  const data = encodeFunctionData({ abi: FCC_INSTRUCTION_SENDER_ABI, functionName: 'dispatchConfidential', args: [identifier(input.opType), identifier(input.command), input.actionId, keccak256(input.envelope), input.envelope, 3n, BigInt(input.expiry)] });
  return { from, to, data, value: input.value ?? 0n, chainId: 114 };
}

export function buildSubmitFccResultTransaction(input: { readonly from: Address | string; readonly instructionSender: Address | string; readonly result: FccResultInput }): UnsignedWalletTransaction {
  const from = getAddress(input.from); const to = getAddress(input.instructionSender); const result = input.result;
  if (!/^0x[0-9a-fA-F]{64}$/.test(result.id) || !/^0x[0-9a-fA-F]{64}$/.test(result.data) || result.status !== 1) throw new Error('FCC_RESULT_SCHEMA');
  if (!/^0x[0-9a-fA-F]{130}$/.test(result.signature)) throw new Error('FCC_RESULT_SIGNATURE');
  const data = encodeFunctionData({ abi: FCC_INSTRUCTION_SENDER_ABI, functionName: 'submitFccResult', args: [result.id, result.data, result.submissionTag, result.status, result.signature] });
  return { from, to, data, value: 0n, chainId: 114 };
}

function identifier(value: string | Hex): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value as Hex;
  return bytes32Identifier(value);
}
