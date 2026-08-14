export interface PublicEventDefinition {
  readonly name: string;
  readonly fields: readonly string[];
}

/** Canonical public event ABI boundary. Private coordination payloads never enter this catalog. */
export const PUBLIC_EVENT_CATALOG: readonly PublicEventDefinition[] = [
  { name: 'SourceConfigured', fields: ['source', 'allowed'] },
  { name: 'SnapshotPolicyConfigured', fields: ['maxAge', 'hashRequired'] },
  { name: 'RouteExecuted', fields: ['commitment', 'seller', 'inputAmount', 'outputAmount'] },
  { name: 'EligibilityRegistryConfigured', fields: ['registry'] },
  { name: 'ProtocolFeeConfigured', fields: ['feeBps', 'recipient'] },
  { name: 'LiquidationFundingSourceConfigured', fields: ['source', 'allowed'] },
  { name: 'LiquidationAdapterConfigured', fields: ['adapter', 'allowed'] },
  { name: 'RouterPaused', fields: ['paused'] },
  { name: 'LegacyRouteConfigured', fields: ['enabled'] },
  { name: 'SwapRouteExecuted', fields: ['commitment', 'seller', 'recipient', 'sellToken', 'buyToken', 'inputAmount', 'grossOutput', 'netOutput'] },
  { name: 'LiquidationRouteExecuted', fields: ['commitment', 'winner', 'recipient', 'venue', 'market', 'position', 'repaid', 'netCollateral'] },
  { name: 'OrderFilled', fields: ['orderHash', 'maker', 'taker', 'sellAmount', 'buyAmount'] },
  { name: 'ProtocolFeeCollected', fields: ['orderHash', 'recipient', 'amount'] },
  { name: 'OrderCancelled', fields: ['orderHash', 'maker'] },
  { name: 'PairSaltAdvanced', fields: ['maker', 'pairSalt'] },
  { name: 'DelegatedSignerConfigured', fields: ['maker', 'signer', 'active'] },
  { name: 'RouterConfigured', fields: ['router'] },
  { name: 'FacilityConfigured', fields: ['facility', 'registered', 'paused', 'revoked'] },
  { name: 'Deposit', fields: ['caller', 'receiver', 'assets', 'shares'] },
  { name: 'Withdraw', fields: ['caller', 'receiver', 'owner', 'assets', 'shares'] },
  { name: 'WithdrawalRequested', fields: ['requestId', 'owner', 'receiver', 'shares', 'minAssets'] },
  { name: 'WithdrawalSettled', fields: ['requestId', 'receiver', 'assets'] },
  { name: 'WithdrawalCancelled', fields: ['requestId', 'owner', 'shares'] },
  { name: 'AdapterConfigured', fields: ['adapter', 'allowed'] },
  { name: 'QuotePolicyConfigured', fields: ['maxDecisionBlockAge'] },
  { name: 'RwaConfigured', fields: ['rwa', 'navPerUnit', 'approved'] },
  { name: 'InventoryBooked', fields: ['rwa', 'nav'] },
  { name: 'InventoryLotBooked', fields: ['lotId', 'rwa', 'inventoryAmount', 'acquisitionCost', 'verifiedNav'] },
  { name: 'InventoryLotNavUpdated', fields: ['lotId', 'verifiedNav', 'carryingValue'] },
  { name: 'RedemptionBooked', fields: ['requestId', 'expectedAssets'] },
  { name: 'RedemptionSettled', fields: ['requestId', 'receivedAssets', 'realizedLoss'] },
  { name: 'FdcVerificationConfigured', fields: ['verification'] },
  { name: 'Web2JsonNavAccepted', fields: ['asset', 'requestDigest', 'votingRound', 'asOf', 'validUntil', 'value', 'decimals'] },
  { name: 'Web2JsonPolicyConfigured', fields: ['asset', 'sourceId', 'requestBodyHash'] },
  { name: 'InstructionDispatched', fields: ['opType', 'command', 'actionId', 'payloadCommitment', 'expiry'] },
  { name: 'TEERegistered', fields: ['tee', 'registered'] },
  { name: 'FccConfigured', fields: ['extensionRegistry', 'machineRegistry', 'extensionId', 'quorumThreshold'] },
  { name: 'FccInstructionSubmitted', fields: ['instructionId', 'actionId', 'teeCount', 'quorumThreshold'] },
  { name: 'OperationScheduled', fields: ['operationId', 'target', 'value', 'eta'] },
  { name: 'OperationExecuted', fields: ['operationId', 'target', 'value'] },
  { name: 'OperationCancelled', fields: ['operationId'] },
  { name: 'Upgraded', fields: ['implementation'] },
  { name: 'AdminChanged', fields: ['previousAdmin', 'newAdmin'] },
  { name: 'OwnershipTransferred', fields: ['previousOwner', 'newOwner'] },
  { name: 'PolicyConfigured', fields: ['policyId', 'wallet', 'roles', 'validFrom', 'expiry', 'issuerReference', 'revocationEpoch'] },
  { name: 'PolicyRevoked', fields: ['policyId', 'revocationEpoch'] },
  { name: 'PolicyUpdateScheduled', fields: ['policyId', 'eta'] },
  { name: 'PolicyUpdateCancelled', fields: ['policyId'] },
] as const;

/**
 * The decoder ABI for every public event emitted by the Flare contracts.
 * Keep this alongside the catalog so indexers cannot silently fall back to a
 * partial event surface when a new public event is added.
 */
export const PUBLIC_EVENT_ABI = [
  { type: 'event', name: 'SourceConfigured', inputs: [{ indexed: true, name: 'source', type: 'address' }, { indexed: false, name: 'allowed', type: 'bool' }] },
  { type: 'event', name: 'SnapshotPolicyConfigured', inputs: [{ indexed: false, name: 'maxAge', type: 'uint256' }, { indexed: false, name: 'hashRequired', type: 'bool' }] },
  { type: 'event', name: 'RouteExecuted', inputs: [{ indexed: true, name: 'commitment', type: 'bytes32' }, { indexed: true, name: 'seller', type: 'address' }, { indexed: false, name: 'inputAmount', type: 'uint256' }, { indexed: false, name: 'outputAmount', type: 'uint256' }] },
  { type: 'event', name: 'EligibilityRegistryConfigured', inputs: [{ indexed: true, name: 'registry', type: 'address' }] },
  { type: 'event', name: 'ProtocolFeeConfigured', inputs: [{ indexed: false, name: 'feeBps', type: 'uint16' }, { indexed: true, name: 'recipient', type: 'address' }] },
  { type: 'event', name: 'LiquidationFundingSourceConfigured', inputs: [{ indexed: true, name: 'source', type: 'address' }, { indexed: false, name: 'allowed', type: 'bool' }] },
  { type: 'event', name: 'LiquidationAdapterConfigured', inputs: [{ indexed: true, name: 'adapter', type: 'address' }, { indexed: false, name: 'allowed', type: 'bool' }] },
  { type: 'event', name: 'RouterPaused', inputs: [{ indexed: false, name: 'paused', type: 'bool' }] },
  { type: 'event', name: 'LegacyRouteConfigured', inputs: [{ indexed: false, name: 'enabled', type: 'bool' }] },
  { type: 'event', name: 'SwapRouteExecuted', inputs: [{ indexed: true, name: 'commitment', type: 'bytes32' }, { indexed: true, name: 'seller', type: 'address' }, { indexed: true, name: 'recipient', type: 'address' }, { indexed: false, name: 'sellToken', type: 'address' }, { indexed: false, name: 'buyToken', type: 'address' }, { indexed: false, name: 'inputAmount', type: 'uint256' }, { indexed: false, name: 'grossOutput', type: 'uint256' }, { indexed: false, name: 'netOutput', type: 'uint256' }] },
  { type: 'event', name: 'LiquidationRouteExecuted', inputs: [{ indexed: true, name: 'commitment', type: 'bytes32' }, { indexed: true, name: 'winner', type: 'address' }, { indexed: true, name: 'recipient', type: 'address' }, { indexed: false, name: 'venue', type: 'address' }, { indexed: false, name: 'market', type: 'address' }, { indexed: false, name: 'position', type: 'bytes32' }, { indexed: false, name: 'repaid', type: 'uint256' }, { indexed: false, name: 'netCollateral', type: 'uint256' }] },
  { type: 'event', name: 'OrderFilled', inputs: [{ indexed: true, name: 'orderHash', type: 'bytes32' }, { indexed: true, name: 'maker', type: 'address' }, { indexed: true, name: 'taker', type: 'address' }, { indexed: false, name: 'sellAmount', type: 'uint256' }, { indexed: false, name: 'buyAmount', type: 'uint256' }] },
  { type: 'event', name: 'ProtocolFeeCollected', inputs: [{ indexed: true, name: 'orderHash', type: 'bytes32' }, { indexed: true, name: 'recipient', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }] },
  { type: 'event', name: 'OrderCancelled', inputs: [{ indexed: true, name: 'orderHash', type: 'bytes32' }, { indexed: true, name: 'maker', type: 'address' }] },
  { type: 'event', name: 'PairSaltAdvanced', inputs: [{ indexed: true, name: 'maker', type: 'address' }, { indexed: true, name: 'pairSalt', type: 'bytes32' }] },
  { type: 'event', name: 'DelegatedSignerConfigured', inputs: [{ indexed: true, name: 'maker', type: 'address' }, { indexed: true, name: 'signer', type: 'address' }, { indexed: false, name: 'active', type: 'bool' }] },
  { type: 'event', name: 'RouterConfigured', inputs: [{ indexed: true, name: 'router', type: 'address' }] },
  { type: 'event', name: 'FacilityConfigured', inputs: [{ indexed: true, name: 'facility', type: 'address' }, { indexed: false, name: 'registered', type: 'bool' }, { indexed: false, name: 'paused', type: 'bool' }, { indexed: false, name: 'revoked', type: 'bool' }] },
  { type: 'event', name: 'Deposit', inputs: [{ indexed: true, name: 'caller', type: 'address' }, { indexed: true, name: 'receiver', type: 'address' }, { indexed: false, name: 'assets', type: 'uint256' }, { indexed: false, name: 'shares', type: 'uint256' }] },
  { type: 'event', name: 'Withdraw', inputs: [{ indexed: true, name: 'caller', type: 'address' }, { indexed: true, name: 'receiver', type: 'address' }, { indexed: true, name: 'owner', type: 'address' }, { indexed: false, name: 'assets', type: 'uint256' }, { indexed: false, name: 'shares', type: 'uint256' }] },
  { type: 'event', name: 'WithdrawalRequested', inputs: [{ indexed: true, name: 'requestId', type: 'uint256' }, { indexed: true, name: 'owner', type: 'address' }, { indexed: true, name: 'receiver', type: 'address' }, { indexed: false, name: 'shares', type: 'uint256' }, { indexed: false, name: 'minAssets', type: 'uint256' }] },
  { type: 'event', name: 'WithdrawalSettled', inputs: [{ indexed: true, name: 'requestId', type: 'uint256' }, { indexed: true, name: 'receiver', type: 'address' }, { indexed: false, name: 'assets', type: 'uint256' }] },
  { type: 'event', name: 'WithdrawalCancelled', inputs: [{ indexed: true, name: 'requestId', type: 'uint256' }, { indexed: true, name: 'owner', type: 'address' }, { indexed: false, name: 'shares', type: 'uint256' }] },
  { type: 'event', name: 'AdapterConfigured', inputs: [{ indexed: true, name: 'adapter', type: 'address' }, { indexed: false, name: 'allowed', type: 'bool' }] },
  { type: 'event', name: 'QuotePolicyConfigured', inputs: [{ indexed: false, name: 'maxDecisionBlockAge', type: 'uint256' }] },
  { type: 'event', name: 'RwaConfigured', inputs: [{ indexed: true, name: 'rwa', type: 'address' }, { indexed: false, name: 'navPerUnit', type: 'uint256' }, { indexed: false, name: 'approved', type: 'bool' }] },
  { type: 'event', name: 'InventoryBooked', inputs: [{ indexed: true, name: 'rwa', type: 'address' }, { indexed: false, name: 'nav', type: 'uint256' }] },
  { type: 'event', name: 'InventoryLotBooked', inputs: [{ indexed: true, name: 'lotId', type: 'uint256' }, { indexed: true, name: 'rwa', type: 'address' }, { indexed: false, name: 'inventoryAmount', type: 'uint256' }, { indexed: false, name: 'acquisitionCost', type: 'uint256' }, { indexed: false, name: 'verifiedNav', type: 'uint256' }] },
  { type: 'event', name: 'InventoryLotNavUpdated', inputs: [{ indexed: true, name: 'lotId', type: 'uint256' }, { indexed: false, name: 'verifiedNav', type: 'uint256' }, { indexed: false, name: 'carryingValue', type: 'uint256' }] },
  { type: 'event', name: 'RedemptionBooked', inputs: [{ indexed: true, name: 'requestId', type: 'bytes32' }, { indexed: false, name: 'expectedAssets', type: 'uint256' }] },
  { type: 'event', name: 'RedemptionSettled', inputs: [{ indexed: true, name: 'requestId', type: 'bytes32' }, { indexed: false, name: 'receivedAssets', type: 'uint256' }, { indexed: false, name: 'realizedLoss', type: 'uint256' }] },
  { type: 'event', name: 'FdcVerificationConfigured', inputs: [{ indexed: true, name: 'verification', type: 'address' }] },
  { type: 'event', name: 'Web2JsonNavAccepted', inputs: [{ indexed: true, name: 'asset', type: 'address' }, { indexed: true, name: 'requestDigest', type: 'bytes32' }, { indexed: false, name: 'votingRound', type: 'uint64' }, { indexed: false, name: 'asOf', type: 'uint64' }, { indexed: false, name: 'validUntil', type: 'uint64' }, { indexed: false, name: 'value', type: 'uint256' }, { indexed: false, name: 'decimals', type: 'uint8' }] },
  { type: 'event', name: 'Web2JsonPolicyConfigured', inputs: [{ indexed: true, name: 'asset', type: 'address' }, { indexed: true, name: 'sourceId', type: 'bytes32' }, { indexed: false, name: 'requestBodyHash', type: 'bytes32' }] },
  { type: 'event', name: 'InstructionDispatched', inputs: [{ indexed: true, name: 'opType', type: 'bytes32' }, { indexed: true, name: 'command', type: 'bytes32' }, { indexed: true, name: 'actionId', type: 'bytes32' }, { indexed: false, name: 'payloadCommitment', type: 'bytes32' }, { indexed: false, name: 'expiry', type: 'uint64' }] },
  { type: 'event', name: 'TEERegistered', inputs: [{ indexed: true, name: 'tee', type: 'address' }, { indexed: false, name: 'registered', type: 'bool' }] },
  { type: 'event', name: 'FccConfigured', inputs: [{ indexed: true, name: 'extensionRegistry', type: 'address' }, { indexed: true, name: 'machineRegistry', type: 'address' }, { indexed: false, name: 'extensionId', type: 'uint256' }, { indexed: false, name: 'quorumThreshold', type: 'uint64' }] },
  { type: 'event', name: 'FccInstructionSubmitted', inputs: [{ indexed: true, name: 'instructionId', type: 'bytes32' }, { indexed: true, name: 'actionId', type: 'bytes32' }, { indexed: false, name: 'teeCount', type: 'uint256' }, { indexed: false, name: 'quorumThreshold', type: 'uint64' }] },
  { type: 'event', name: 'OperationScheduled', inputs: [{ indexed: true, name: 'operationId', type: 'bytes32' }, { indexed: true, name: 'target', type: 'address' }, { indexed: false, name: 'value', type: 'uint256' }, { indexed: false, name: 'eta', type: 'uint64' }] },
  { type: 'event', name: 'OperationExecuted', inputs: [{ indexed: true, name: 'operationId', type: 'bytes32' }, { indexed: true, name: 'target', type: 'address' }, { indexed: false, name: 'value', type: 'uint256' }] },
  { type: 'event', name: 'OperationCancelled', inputs: [{ indexed: true, name: 'operationId', type: 'bytes32' }] },
  { type: 'event', name: 'Upgraded', inputs: [{ indexed: true, name: 'implementation', type: 'address' }] },
  { type: 'event', name: 'AdminChanged', inputs: [{ indexed: false, name: 'previousAdmin', type: 'address' }, { indexed: false, name: 'newAdmin', type: 'address' }] },
  { type: 'event', name: 'OwnershipTransferred', inputs: [{ indexed: true, name: 'previousOwner', type: 'address' }, { indexed: true, name: 'newOwner', type: 'address' }] },
  { type: 'event', name: 'PolicyConfigured', inputs: [{ indexed: true, name: 'policyId', type: 'bytes32' }, { indexed: true, name: 'wallet', type: 'address' }, { indexed: false, name: 'roles', type: 'uint256' }, { indexed: false, name: 'validFrom', type: 'uint64' }, { indexed: false, name: 'expiry', type: 'uint64' }, { indexed: false, name: 'issuerReference', type: 'bytes32' }, { indexed: false, name: 'revocationEpoch', type: 'uint256' }] },
  { type: 'event', name: 'PolicyRevoked', inputs: [{ indexed: true, name: 'policyId', type: 'bytes32' }, { indexed: false, name: 'revocationEpoch', type: 'uint256' }] },
  { type: 'event', name: 'PolicyUpdateScheduled', inputs: [{ indexed: true, name: 'policyId', type: 'bytes32' }, { indexed: false, name: 'eta', type: 'uint64' }] },
  { type: 'event', name: 'PolicyUpdateCancelled', inputs: [{ indexed: true, name: 'policyId', type: 'bytes32' }] },
] as const;

const catalogByName = new Map(PUBLIC_EVENT_CATALOG.map((event) => [event.name, event]));
const PRIVATE_EVENT_FIELDS = new Set(['ciphertext', 'plaintext', 'signature', 'proofBytes', 'privateKey', 'bidPayload']);

export function assertCanonicalPublicEvent(event: Record<string, unknown>): void {
  if (!event || typeof event.kind !== 'string' || !event.kind.trim()) throw new Error('EVENT_INVALID');
  if (typeof event.txHash !== 'string' || !event.txHash.trim() || typeof event.commitment !== 'string' || !event.commitment.trim()) throw new Error('EVENT_INVALID');
  for (const field of Object.keys(event)) {
    if (PRIVATE_EVENT_FIELDS.has(field)) throw new Error('EVENT_PRIVATE_FIELD');
  }
  const definition = catalogByName.get(event.kind);
  if (!definition) throw new Error('EVENT_KIND_UNKNOWN');
  const metadata = new Set(['txHash', 'logIndex', 'blockNumber', 'blockHash', 'kind', 'commitment']);
  for (const field of Object.keys(event)) {
    if (!metadata.has(field) && !definition.fields.includes(field)) throw new Error('EVENT_FIELD_UNKNOWN');
  }
}
