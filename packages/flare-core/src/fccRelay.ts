import { encodeAbiParameters, encodePacked, hashMessage, keccak256, recoverAddress, type Hex } from 'viem';

export interface FccActionResult {
  readonly id: Hex; // FCC instruction ID, not the TrustRFQ logical action ID
  readonly submissionTag: string;
  readonly status: number;
  readonly data: Hex;
  readonly signature: Hex;
}

export interface FccActionResponse {
  readonly result?: {
    readonly id?: string;
    readonly submissionTag?: string;
    readonly status?: number;
    readonly data?: string;
    readonly log?: string;
  };
  readonly signature?: string;
}

/** Maps a tee-node `/action/result` body onto TrustRFQ `submitFccResult` args. */
export function parseFccActionResponse(response: FccActionResponse): FccActionResult {
  const result = response.result;
  const id = result?.id ?? '';
  const data = result?.data ?? '';
  const signature = response.signature ?? '';
  const submissionTag = result?.submissionTag ?? '';
  const status = result?.status;
  if (status !== 1) throw new Error('RESULT_STATUS');
  if (!/^0x[0-9a-fA-F]{64}$/.test(id) || !/^0x[0-9a-fA-F]{64}$/.test(data) || /^0x0+$/.test(data)) {
    throw new Error('RESULT_SCHEMA');
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || submissionTag.length === 0) throw new Error('RESULT_SCHEMA');
  return { id: id as Hex, submissionTag, status, data: data as Hex, signature: signature as Hex };
}

export interface FccInstructionBinding {
  readonly instructionId: Hex;
  readonly logicalActionId: Hex;
  readonly selectedSigners: readonly Hex[];
  readonly expiry: number;
  readonly expectedSubmissionTag?: string;
}

export interface FccRelayAcceptance {
  readonly logicalActionId: Hex;
  readonly instructionId: Hex;
  readonly signer: Hex;
  readonly routeHash: Hex;
  readonly ready: boolean;
  readonly signers: readonly Hex[];
}

/** Mirrors ActionResult.Hash() inputs used by the Solidity sender. */
export function fccActionResultHash(result: Pick<FccActionResult, 'id' | 'submissionTag' | 'status' | 'data'>): Hex {
  return keccak256(encodePacked(['bytes32', 'bytes32', 'bytes32', 'uint8'], [keccak256(result.data), result.id, keccak256(new TextEncoder().encode(result.submissionTag)), result.status]));
}

/** Weather's domain-separated TEE_ACTION_RESULT payload before EIP-191. */
export function fccActionResultDigest(chainId: number | bigint, result: Pick<FccActionResult, 'id' | 'submissionTag' | 'status' | 'data'>): Hex {
  const actionHash = fccActionResultHash(result);
  const domainPayload = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }], [
    `0x${Array.from(new TextEncoder().encode('TEE_ACTION_RESULT'), (byte) => byte.toString(16).padStart(2, '0')).join('').padEnd(64, '0')}` as Hex,
    BigInt(chainId),
    actionHash,
  ]));
  return domainPayload;
}

export class FccResultRelay {
  private readonly bindings = new Map<string, FccInstructionBinding>();
  private readonly accepted = new Map<string, Set<string>>();
  private readonly hashes = new Map<string, Hex>();

  bindInstruction(binding: FccInstructionBinding): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(binding.instructionId) || !/^0x[0-9a-fA-F]{64}$/.test(binding.logicalActionId)) throw new Error('FCC_INSTRUCTION_ID');
    if (binding.selectedSigners.length !== 3 || new Set(binding.selectedSigners.map((value) => value.toLowerCase())).size !== 3) throw new Error('FCC_TEE_COUNT');
    if (this.bindings.has(binding.instructionId.toLowerCase())) throw new Error('FCC_INSTRUCTION_REPLAY');
    this.bindings.set(binding.instructionId.toLowerCase(), binding);
    this.accepted.set(binding.instructionId.toLowerCase(), new Set());
  }

  async accept(chainId: number | bigint, result: FccActionResult, now: number): Promise<FccRelayAcceptance> {
    if (BigInt(chainId) !== 114n) throw new Error('FCC_CHAIN_ID');
    const key = result.id.toLowerCase();
    const binding = this.bindings.get(key);
    if (!binding) throw new Error('UNKNOWN_INSTRUCTION');
    if (now > binding.expiry) throw new Error('RESULT_EXPIRED');
    if (result.status !== 1 || result.submissionTag.length === 0 || result.submissionTag !== (binding.expectedSubmissionTag ?? 'trust-rfq') || result.data.length !== 66) throw new Error('RESULT_SCHEMA');
    const routeHash = result.data as Hex;
    if (/^0x0+$/.test(routeHash)) throw new Error('RESULT_SCHEMA');
    const signer = await recoverAddress({ hash: hashMessage({ raw: fccActionResultDigest(chainId, result) }), signature: result.signature });
    const selected = binding.selectedSigners.map((value) => value.toLowerCase());
    if (!selected.includes(signer.toLowerCase())) throw new Error('TEE_NOT_SELECTED');
    const signers = this.accepted.get(key)!;
    if (signers.has(signer.toLowerCase())) throw new Error('TEE_RESULT_REPLAY');
    const prior = this.hashes.get(key);
    if (prior && prior.toLowerCase() !== routeHash.toLowerCase()) throw new Error('RESULT_DISSENT');
    this.hashes.set(key, routeHash);
    signers.add(signer.toLowerCase());
    return { logicalActionId: binding.logicalActionId, instructionId: binding.instructionId, signer, routeHash, ready: signers.size >= 2, signers: [...signers] as Hex[] };
  }
}
