import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  padHex,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { getNetworkConfig, type FlareNetwork } from '../../flare-core/src/network';
import type { FtsoFeed } from '../../flare-core/src/oracles';

const CONTRACT_REGISTRY_ABI = [{
  type: 'function',
  name: 'getContractAddressByName',
  stateMutability: 'view',
  inputs: [{ name: '_name', type: 'string' }],
  outputs: [{ name: '', type: 'address' }],
}] as const;

const FTSO_V2_ABI = [{
  type: 'function',
  name: 'getFeedById',
  stateMutability: 'payable',
  inputs: [{ name: '_feedId', type: 'bytes21' }],
  outputs: [
    { name: '_value', type: 'uint256' },
    { name: '_decimals', type: 'int8' },
    { name: '_timestamp', type: 'uint64' },
  ],
}] as const;

const FDC_HUB_ABI = [{
  type: 'function',
  name: 'requestAttestation',
  stateMutability: 'payable',
  inputs: [{ name: '_data', type: 'bytes' }],
  outputs: [],
}] as const;

const FDC_FEE_ABI = [{
  type: 'function', name: 'getRequestFee', stateMutability: 'view',
  inputs: [{ name: '_data', type: 'bytes' }], outputs: [{ name: '', type: 'uint256' }],
}] as const;

const FLARE_SYSTEMS_MANAGER_ABI = [
  { type: 'function', name: 'firstVotingRoundStartTs', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'votingEpochDurationSeconds', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
] as const;

const FDC_VERIFICATION_ABI = [
  {
    type: 'function',
    name: 'fdcProtocolId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '_fdcProtocolId', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'relay',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const RELAY_ABI = [{
  type: 'function',
  name: 'isFinalized',
  stateMutability: 'view',
  inputs: [
    { name: '_protocolId', type: 'uint256' },
    { name: '_votingRoundId', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

export interface LiveFtsoFeedInput {
  readonly network: FlareNetwork;
  readonly registryAddress: Address;
  readonly feedId: Hex;
}

export interface UnsignedFdcRequestTransaction {
  readonly to: Address;
  readonly chainId: number;
  readonly value: bigint;
  readonly data: Hex;
}

export interface FdcRequestTransactionInput {
  readonly network: FlareNetwork;
  readonly registryAddress: Address;
  readonly requestBytes: Hex;
  readonly feeWei: bigint;
}

export interface FdcRequestPreparation {
  readonly abiEncodedRequest: Hex;
  readonly feeWei: bigint;
  readonly hub: Address;
  readonly feeContract: Address;
  readonly chainId: number;
}

export interface FdcRoundFinalityOptions {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
}

export async function readLiveFtsoFeed(
  client: PublicClient,
  input: LiveFtsoFeedInput,
): Promise<FtsoFeed> {
  const expected = getNetworkConfig(input.network);
  const chainId = await client.getChainId();
  if (chainId !== expected.chainId) {
    throw new Error(`FTSO_CHAIN_ID: expected ${expected.chainId}, received ${chainId}`);
  }
  if (!isAddress(input.registryAddress) || getAddress(input.registryAddress) === '0x0000000000000000000000000000000000000000') {
    throw new Error('FTSO_REGISTRY_ADDRESS');
  }
  if (!/^0x[0-9a-fA-F]{42}$/.test(input.feedId)) throw new Error('FTSO_FEED_ID');

  const ftsoAddress = await readRegistryAddress(client, input.registryAddress, 'FtsoV2');
  if (!isAddress(ftsoAddress) || getAddress(ftsoAddress) === '0x0000000000000000000000000000000000000000') {
    throw new Error('FTSO_CONTRACT_MISSING');
  }
  const result = await client.readContract({
    address: getAddress(ftsoAddress),
    abi: FTSO_V2_ABI,
    functionName: 'getFeedById',
    args: [input.feedId],
  });
  const [value, decimals, timestamp] = result as readonly [bigint, number, bigint];
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || timestampNumber < 0) throw new Error('FTSO_TIMESTAMP');
  return { feedId: input.feedId, value, decimals, timestamp: timestampNumber };
}

export async function buildUnsignedFdcRequestTransaction(
  client: PublicClient,
  input: FdcRequestTransactionInput,
): Promise<UnsignedFdcRequestTransaction> {
  const expected = getNetworkConfig(input.network);
  const chainId = await client.getChainId();
  if (chainId !== expected.chainId) {
    throw new Error(`FDC_CHAIN_ID: expected ${expected.chainId}, received ${chainId}`);
  }
  assertRegistryAddress(input.registryAddress);
  if (!/^0x[0-9a-fA-F]+$/.test(input.requestBytes) || input.requestBytes === '0x') throw new Error('FDC_REQUEST_BYTES');
  if (input.feeWei < 0n) throw new Error('FDC_FEE');
  const hub = await readRegistryAddress(client, input.registryAddress, 'FdcHub');
  return {
    to: hub,
    chainId,
    value: input.feeWei,
    data: encodeFunctionData({ abi: FDC_HUB_ABI, functionName: 'requestAttestation', args: [input.requestBytes] }),
  };
}

export async function prepareFdcRequestTransaction(
  client: PublicClient,
  input: { readonly network: FlareNetwork; readonly registryAddress: Address; readonly requestBytes: Hex },
): Promise<FdcRequestPreparation & UnsignedFdcRequestTransaction> {
  const expected = getNetworkConfig(input.network);
  const chainId = await client.getChainId();
  if (chainId !== expected.chainId) throw new Error(`FDC_CHAIN_ID: expected ${expected.chainId}, received ${chainId}`);
  assertRegistryAddress(input.registryAddress);
  if (!/^0x[0-9a-fA-F]+$/.test(input.requestBytes) || input.requestBytes === '0x') throw new Error('FDC_REQUEST_BYTES');
  const [hub, feeContract] = await Promise.all([
    readRegistryAddress(client, input.registryAddress, 'FdcHub'),
    readRegistryAddress(client, input.registryAddress, 'FdcRequestFeeConfigurations'),
  ]);
  const feeWei = await client.readContract({ address: feeContract, abi: FDC_FEE_ABI, functionName: 'getRequestFee', args: [input.requestBytes] }) as bigint;
  if (feeWei < 0n) throw new Error('FDC_FEE');
  return {
    to: hub,
    chainId,
    value: feeWei,
    data: encodeFunctionData({ abi: FDC_HUB_ABI, functionName: 'requestAttestation', args: [input.requestBytes] }),
    abiEncodedRequest: input.requestBytes,
    feeWei,
    hub,
    feeContract,
  };
}

export function calculateFdcVotingRound(blockTimestamp: bigint, firstRoundStartTimestamp: bigint, epochDurationSeconds: bigint): number {
  if (blockTimestamp < firstRoundStartTimestamp || epochDurationSeconds <= 0n) throw new Error('FDC_ROUND_TIMESTAMP');
  const round = (blockTimestamp - firstRoundStartTimestamp) / epochDurationSeconds;
  if (round > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FDC_ROUND_ID');
  return Number(round);
}

export async function calculateFdcVotingRoundFromBlock(
  client: PublicClient,
  registryAddress: Address,
  blockNumber: bigint,
): Promise<number> {
  if (blockNumber < 0n) throw new Error('FDC_BLOCK_NUMBER');
  const manager = await readRegistryAddress(client, registryAddress, 'FlareSystemsManager');
  const [start, duration, block] = await Promise.all([
    client.readContract({ address: manager, abi: FLARE_SYSTEMS_MANAGER_ABI, functionName: 'firstVotingRoundStartTs' }) as Promise<bigint>,
    client.readContract({ address: manager, abi: FLARE_SYSTEMS_MANAGER_ABI, functionName: 'votingEpochDurationSeconds' }) as Promise<bigint>,
    client.getBlock({ blockNumber }),
  ]);
  return calculateFdcVotingRound(block.timestamp, start, duration);
}

export async function waitForFdcRoundFinality(
  reader: (votingRoundId: number) => Promise<{ readonly protocolId: number; readonly finalized: boolean }>,
  votingRoundId: number,
  options: FdcRoundFinalityOptions = {},
): Promise<{ readonly protocolId: number; readonly finalized: true }> {
  const intervalMs = options.intervalMs ?? 15_000;
  const maxAttempts = options.maxAttempts ?? 20;
  if (!Number.isSafeInteger(votingRoundId) || votingRoundId < 0 || intervalMs < 0 || maxAttempts <= 0) throw new Error('FDC_FINALITY_OPTIONS');
  let latestProtocolId = -1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await reader(votingRoundId);
    latestProtocolId = result.protocolId;
    if (result.finalized) return { protocolId: result.protocolId, finalized: true };
    if (attempt + 1 < maxAttempts && intervalMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`FDC_FINALITY_TIMEOUT:${votingRoundId}:${latestProtocolId}`);
}

export async function readFdcRoundFinality(
  client: PublicClient,
  input: { readonly network: FlareNetwork; readonly registryAddress: Address; readonly votingRoundId: number },
): Promise<{ readonly protocolId: number; readonly finalized: boolean }> {
  const expected = getNetworkConfig(input.network);
  const chainId = await client.getChainId();
  if (chainId !== expected.chainId) throw new Error(`FDC_CHAIN_ID: expected ${expected.chainId}, received ${chainId}`);
  assertRegistryAddress(input.registryAddress);
  if (!Number.isSafeInteger(input.votingRoundId) || input.votingRoundId < 0) throw new Error('FDC_ROUND_ID');
  const verification = await readRegistryAddress(client, input.registryAddress, 'FdcVerification');
  const protocolIdRaw = await client.readContract({
    address: verification,
    abi: FDC_VERIFICATION_ABI,
    functionName: 'fdcProtocolId',
  }) as number | bigint;
  const protocolId = Number(protocolIdRaw);
  if (!Number.isSafeInteger(protocolId) || protocolId < 0) throw new Error('FDC_PROTOCOL_ID');
  const relay = await client.readContract({
    address: verification,
    abi: FDC_VERIFICATION_ABI,
    functionName: 'relay',
  }) as Address;
  if (!isAddress(relay) || getAddress(relay) === '0x0000000000000000000000000000000000000000') throw new Error('FDC_RELAY_MISSING');
  const finalized = await client.readContract({
    address: getAddress(relay),
    abi: RELAY_ABI,
    functionName: 'isFinalized',
    args: [BigInt(protocolId), BigInt(input.votingRoundId)],
  }) as boolean;
  return { protocolId, finalized };
}

export interface FdcPreparedRequest {
  readonly abiEncodedRequest: Hex;
  readonly [key: string]: unknown;
}

export interface FdcProofResponse {
  readonly proofs: readonly Hex[];
  readonly responseHex: Hex;
  readonly attestationType?: Hex;
  readonly [key: string]: unknown;
}

export interface FdcWeb2JsonRequestBody {
  readonly url: string;
  readonly httpMethod: string;
  readonly headers: string;
  readonly queryParams: string;
  readonly body: string;
  readonly postProcessJq: string;
  readonly abiSignature: string;
}

export interface FdcWeb2JsonResponse {
  readonly attestationType: Hex;
  readonly sourceId: Hex;
  readonly votingRound: bigint;
  readonly lowestUsedTimestamp: bigint;
  readonly requestBody: FdcWeb2JsonRequestBody;
  readonly responseBody: { readonly abiEncodedData: Hex };
}

export interface FdcWeb2JsonProof {
  readonly merkleProof: readonly Hex[];
  readonly data: FdcWeb2JsonResponse;
}

const WEB2_JSON_RESPONSE_ABI = [{
  type: 'tuple',
  components: [
    { name: 'attestationType', type: 'bytes32' },
    { name: 'sourceId', type: 'bytes32' },
    { name: 'votingRound', type: 'uint64' },
    { name: 'lowestUsedTimestamp', type: 'uint64' },
    {
      name: 'requestBody', type: 'tuple', components: [
        { name: 'url', type: 'string' },
        { name: 'httpMethod', type: 'string' },
        { name: 'headers', type: 'string' },
        { name: 'queryParams', type: 'string' },
        { name: 'body', type: 'string' },
        { name: 'postProcessJq', type: 'string' },
        { name: 'abiSignature', type: 'string' },
      ],
    },
    { name: 'responseBody', type: 'tuple', components: [{ name: 'abiEncodedData', type: 'bytes' }] },
  ],
}] as const;

const WEB2_JSON_REQUEST_BODY_ABI = [{
  type: 'tuple', components: [
    { name: 'url', type: 'string' },
    { name: 'httpMethod', type: 'string' },
    { name: 'headers', type: 'string' },
    { name: 'queryParams', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'postProcessJq', type: 'string' },
    { name: 'abiSignature', type: 'string' },
  ],
}] as const;

const NAV_PROOF_REGISTRY_ABI = [{
  type: 'function', name: 'submitWeb2JsonNavProof', stateMutability: 'nonpayable',
  inputs: [
    {
      name: 'proof', type: 'tuple', components: [
        { name: 'merkleProof', type: 'bytes32[]' },
        { name: 'data', type: 'tuple', components: WEB2_JSON_RESPONSE_ABI[0].components },
      ],
    },
    { name: 'expectedAsset', type: 'address' },
  ], outputs: [],
}] as const;

export function decodeFdcWeb2JsonProof(proofs: readonly Hex[], responseHex: Hex): FdcWeb2JsonProof {
  if (proofs.some((proof) => !/^0x[0-9a-fA-F]+$/.test(proof))) throw new Error('FDC_PROOF_RESPONSE');
  if (!/^0x[0-9a-fA-F]+$/.test(responseHex) || responseHex === '0x') throw new Error('FDC_PROOF_RESPONSE');
  const [decoded] = decodeAbiParameters(WEB2_JSON_RESPONSE_ABI, responseHex);
  const data = decoded as unknown as FdcWeb2JsonResponse;
  if (data.attestationType !== encodeRegistryName('Web2Json', 'FDC_ATTESTATION_TYPE')) throw new Error('FDC_ATTESTATION_TYPE');
  if (!data.responseBody?.abiEncodedData || !data.sourceId) throw new Error('FDC_PROOF_RESPONSE');
  return { merkleProof: [...proofs], data };
}

export function hashFdcWeb2JsonRequestBody(requestBody: FdcWeb2JsonRequestBody): Hex {
  return keccak256(encodeAbiParameters(WEB2_JSON_REQUEST_BODY_ABI, [requestBody]));
}

export interface UnsignedNavProofTransaction {
  readonly to: Address;
  readonly chainId: number;
  readonly value: bigint;
  readonly data: Hex;
}

export function buildUnsignedNavProofTransaction(
  chainId: number,
  navProofRegistry: Address,
  expectedAsset: Address,
  proof: FdcWeb2JsonProof,
): UnsignedNavProofTransaction {
  if (!isAddress(navProofRegistry) || !isAddress(expectedAsset)) throw new Error('FDC_PROOF_ADDRESS');
  if (proof.data.responseBody.abiEncodedData === '0x') throw new Error('FDC_PROOF_RESPONSE');
  return {
    to: getAddress(navProofRegistry),
    chainId,
    value: 0n,
    data: encodeFunctionData({
      abi: NAV_PROOF_REGISTRY_ABI,
      functionName: 'submitWeb2JsonNavProof',
      args: [{ merkleProof: [...proof.merkleProof], data: proof.data }, getAddress(expectedAsset)],
    }),
  };
}

export interface FdcVerifierClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetcher?: typeof fetch;
}

export class FdcVerifierClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetcher: typeof fetch;

  constructor(options: FdcVerifierClientOptions) {
    if (!options.baseUrl.trim()) throw new Error('FDC_BASE_URL');
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? fetch;
  }

  async prepareRequest(
    attestationType: string,
    request: Record<string, unknown>,
  ): Promise<FdcPreparedRequest> {
    const sourceId = request.sourceId;
    if (typeof sourceId !== 'string' || !sourceId.trim()) throw new Error('FDC_SOURCE_ID');
    const requestBody = request.requestBody;
    if (!isRecord(requestBody)) throw new Error('FDC_REQUEST_BODY');
    if (attestationType === 'Web2Json' || /^0x[0-9a-fA-F]{64}$/.test(attestationType) && attestationType === encodeRegistryName('Web2Json', 'FDC_ATTESTATION_TYPE')) {
      assertWeb2JsonRequestBody(requestBody);
    }
    const encodedAttestationType = encodeRegistryName(attestationType, 'FDC_ATTESTATION_TYPE');
    const encodedSourceId = encodeRegistryName(sourceId, 'FDC_SOURCE_ID');
    const verifierFamily = attestationType === 'Web2Json' || encodedAttestationType === encodeRegistryName('Web2Json', 'FDC_ATTESTATION_TYPE') ? 'web2' : 'eth';
    return this.postJson<FdcPreparedRequest>(
      `/verifier/${verifierFamily}/${encodeURIComponent(attestationType)}/prepareRequest`,
      { ...request, attestationType: encodedAttestationType, sourceId: encodedSourceId },
      (body) => {
        if (!isRecord(body) || typeof body.abiEncodedRequest !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.abiEncodedRequest)) {
          throw new Error('FDC_PREPARE_RESPONSE');
        }
        return { ...body, abiEncodedRequest: body.abiEncodedRequest as Hex };
      },
    );
  }

  async getProof(
    daLayerUrl: string,
    votingRoundId: number,
    requestBytes: Hex,
  ): Promise<FdcProofResponse> {
    if (!Number.isSafeInteger(votingRoundId) || votingRoundId < 0) throw new Error('FDC_ROUND_ID');
    if (!/^0x[0-9a-fA-F]+$/.test(requestBytes)) throw new Error('FDC_REQUEST_BYTES');
    const baseUrl = daLayerUrl.trim().replace(/\/$/, '');
    if (!baseUrl) throw new Error('FDC_DA_URL');
    return this.postJsonFromBase<FdcProofResponse>(
      baseUrl,
      '/api/v1/fdc/proof-by-request-round-raw',
      { votingRoundId, requestBytes },
      (body) => {
        if (!isRecord(body)) {
          throw new Error('FDC_PROOF_RESPONSE');
        }
        const proofs = body.proofs ?? body.proof;
        const responseHex = body.responseHex ?? body.response_hex;
        if (!Array.isArray(proofs) || !proofs.every((value) => typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) || typeof responseHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(responseHex)) {
          throw new Error('FDC_PROOF_RESPONSE');
        }
        const attestationType = body.attestationType ?? body.attestation_type;
        return {
          ...body,
          proofs: proofs as Hex[],
          responseHex: responseHex as Hex,
          ...(typeof attestationType === 'string' ? { attestationType: attestationType as Hex } : {}),
        };
      },
    );
  }

  private postJson<T>(path: string, body: Record<string, unknown>, validate: (value: unknown) => T): Promise<T> {
    return this.postJsonFromBase(this.baseUrl, path, body, validate);
  }

  private async postJsonFromBase<T>(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
    validate: (value: unknown) => T,
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const response = await this.fetcher(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('FDC_RESPONSE_JSON');
    }
    if (!response.ok) throw new Error(`FDC_HTTP_${response.status}`);
    return validate(payload);
  }
}

function assertRegistryAddress(registryAddress: Address): void {
  if (!isAddress(registryAddress) || getAddress(registryAddress) === '0x0000000000000000000000000000000000000000') throw new Error('FDC_REGISTRY_ADDRESS');
}

async function readRegistryAddress(
  client: PublicClient,
  registryAddress: Address,
  contractName: 'FtsoV2' | 'FdcHub' | 'FdcVerification' | 'FdcRequestFeeConfigurations' | 'FlareSystemsManager',
): Promise<Address> {
  const address = await client.readContract({
    address: getAddress(registryAddress),
    abi: CONTRACT_REGISTRY_ABI,
    functionName: 'getContractAddressByName',
    args: [contractName],
  }) as Address;
  if (!isAddress(address) || getAddress(address) === '0x0000000000000000000000000000000000000000') throw new Error(`REGISTRY_CONTRACT_MISSING:${contractName}`);
  return getAddress(address);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertWeb2JsonRequestBody(requestBody: Record<string, unknown>): void {
  const abiSignature = requestBody.abiSignature;
  if (typeof abiSignature !== 'string' || !abiSignature.trim()) throw new Error('FDC_ABI_SIGNATURE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(abiSignature);
  } catch {
    throw new Error('FDC_ABI_SIGNATURE');
  }
  if (!isRecord(parsed) || parsed.type !== 'tuple' || typeof parsed.name !== 'string' || !Array.isArray(parsed.components) || parsed.components.length === 0) {
    throw new Error('FDC_ABI_SIGNATURE');
  }
  if (!parsed.components.every((component) => isRecord(component) && typeof component.name === 'string' && typeof component.type === 'string')) {
    throw new Error('FDC_ABI_SIGNATURE');
  }
}

function encodeRegistryName(value: string, code: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value as Hex;
  const encoded = stringToHex(value.trim());
  if (encoded.length > 66) throw new Error(code);
  return padHex(encoded, { dir: 'right', size: 32 });
}
