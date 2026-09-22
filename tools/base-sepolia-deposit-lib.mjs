import { decodeEventLog, getAddress, isAddress } from 'viem';

import {
  BASE_QA_RELEASE_SCHEMA_VERSION,
  BASE_QA_RELEASE_TARGET,
  sha256Manifest,
  validateDepositEvidence,
} from './base-release-gate-lib.mjs';

export const BASE_SEPOLIA_APPROVAL_EVENT = Object.freeze({
  type: 'event',
  name: 'Approval',
  anonymous: false,
  inputs: [
    { indexed: true, name: 'owner', type: 'address' },
    { indexed: true, name: 'spender', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
});

export const BASE_SEPOLIA_DEPOSIT_EVENT = Object.freeze({
  type: 'event',
  name: 'Deposit',
  anonymous: false,
  inputs: [
    { indexed: true, name: 'sender', type: 'address' },
    { indexed: true, name: 'owner', type: 'address' },
    { indexed: false, name: 'assets', type: 'uint256' },
    { indexed: false, name: 'shares', type: 'uint256' },
  ],
});

export function selectBaseSepoliaEvent(logs, kind, { candidate, depositor, transactionFrom } = {}) {
  const event = kind === 'approval' ? BASE_SEPOLIA_APPROVAL_EVENT : kind === 'deposit' ? BASE_SEPOLIA_DEPOSIT_EVENT : undefined;
  if (!event) throw new Error('BASE_QA_DEPOSIT_EVENT_KIND');
  const expectedAddress = kind === 'approval' ? candidate?.nativeUsdc : candidate?.addresses?.facility;
  for (const log of logs ?? []) {
    if (!sameAddress(log?.address, expectedAddress)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (decoded.eventName !== event.name) continue;
    const args = decoded.args ?? {};
    if (kind === 'approval') {
      if (!sameAddress(args.owner, depositor) || !sameAddress(args.spender, candidate?.addresses?.facility) || !positive(args.value)) continue;
      return eventRecord(log, { owner: args.owner, spender: args.spender, value: args.value }, transactionFrom);
    }
    if (!sameAddress(args.sender, depositor) || !sameAddress(args.owner, depositor) || !positive(args.assets) || !positive(args.shares)) continue;
    return eventRecord(log, { sender: args.sender, owner: args.owner, assets: args.assets, shares: args.shares }, transactionFrom);
  }
  return undefined;
}

export function buildBaseSepoliaDepositProof({
  candidate,
  candidateSha256 = sha256Manifest(candidate),
  depositor,
  approvalLogs,
  depositLogs,
  approvalFrom,
  depositFrom,
  sharesBefore,
  sharesAfter,
  checkedAt = new Date().toISOString(),
}) {
  const approval = selectBaseSepoliaEvent(approvalLogs, 'approval', { candidate, depositor, transactionFrom: approvalFrom });
  if (!approval) throw new Error('BASE_QA_APPROVAL_EVENT_MISSING');
  const deposit = selectBaseSepoliaEvent(depositLogs, 'deposit', { candidate, depositor, transactionFrom: depositFrom });
  if (!deposit) throw new Error('BASE_QA_DEPOSIT_EVENT_MISSING');
  const proof = {
    schemaVersion: BASE_QA_RELEASE_SCHEMA_VERSION,
    kind: 'base-sepolia-deposit',
    target: BASE_QA_RELEASE_TARGET,
    chainId: 84532,
    candidateSha256,
    nativeUsdc: candidate.nativeUsdc,
    facility: candidate.addresses.facility,
    depositor: getAddress(depositor),
    approval,
    deposit,
    sharesBefore: stringifyInteger(sharesBefore),
    sharesAfter: stringifyInteger(sharesAfter),
    checkedAt,
  };
  return validateDepositEvidence(proof, candidate, candidateSha256, { depositor });
}

function eventRecord(log, fields, receiptFrom) {
  if (!validHash(log?.transactionHash) || log?.blockNumber === undefined || log?.logIndex === undefined) {
    throw new Error('BASE_QA_DEPOSIT_EVENT_INVALID');
  }
  const record = {
    eventName: fields.owner && fields.spender ? 'Approval' : 'Deposit',
    logAddress: getAddress(log.address),
    transactionHash: log.transactionHash,
    blockNumber: stringifyInteger(log.blockNumber),
    logIndex: stringifyInteger(log.logIndex),
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, stringifyInteger(value)])),
  };
  const normalizedReceiptFrom = normalizeAddress(receiptFrom);
  if (normalizedReceiptFrom) record.receiptFrom = normalizedReceiptFrom;
  return record;
}

function stringifyInteger(value) {
  if (typeof value === 'bigint') return value.toString(10);
  return value === undefined || value === null ? value : String(value);
}

function positive(value) {
  try { return BigInt(value) > 0n; } catch { return false; }
}

function validHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function normalizeAddress(value) {
  try {
    return typeof value === 'string' && isAddress(value) ? getAddress(value) : undefined;
  } catch {
    return undefined;
  }
}

function sameAddress(left, right) {
  try {
    return typeof left === 'string' && typeof right === 'string' && isAddress(left) && isAddress(right) && getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}
