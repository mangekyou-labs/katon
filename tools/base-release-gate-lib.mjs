import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getAddress, isAddress } from 'viem';

import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NATIVE_USDC,
  parseBaseDeploymentManifest,
} from './base-deployment-lib.mjs';

export const BASE_QA_RELEASE_SCHEMA_VERSION = 1;
export const BASE_QA_RELEASE_TARGET = 'sepolia';
/** Versioned proof emitted by the Base Sepolia stock-sale canary. */
export const BASE_SEPOLIA_STOCK_SALE_PROOF_SCHEMA_VERSION = 1;

export function candidatePaths(rootDir, target = BASE_QA_RELEASE_TARGET) {
  if (target !== BASE_QA_RELEASE_TARGET) throw new Error('BASE_QA_RELEASE_TARGET');
  const root = path.resolve(rootDir);
  const candidateDir = path.join(root, 'output/base-qa/sepolia');
  return {
    candidateDir,
    manifestPath: path.join(candidateDir, 'candidate-manifest.json'),
    checkpointPath: path.join(candidateDir, 'candidate-checkpoint.json'),
    smokeProofPath: path.join(candidateDir, 'smoke-proof.json'),
    depositProofPath: path.join(candidateDir, 'deposit-proof.json'),
    swapProofPath: path.join(candidateDir, 'swap-proof.json'),
    publicManifestPath: path.join(root, 'contracts/base/deployments/sepolia.json'),
  };
}

export function candidateManifestPath(rootDir, target = BASE_QA_RELEASE_TARGET) {
  return candidatePaths(rootDir, target).manifestPath;
}

export function resolveCandidateManifestPath(rootDir, requestedPath) {
  const paths = candidatePaths(rootDir);
  const candidatePath = path.resolve(rootDir, requestedPath || paths.manifestPath);
  const relative = path.relative(paths.candidateDir, candidatePath);
  if (candidatePath === paths.publicManifestPath) throw new Error('BASE_QA_CANDIDATE_PUBLIC_PATH');
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('BASE_QA_CANDIDATE_PATH');
  }
  return candidatePath;
}

export function assertCandidateManifestPath(candidatePath, rootDir) {
  return resolveCandidateManifestPath(rootDir, candidatePath);
}

export function resolveCandidateEvidencePath(rootDir, requestedPath, defaultPath) {
  const paths = candidatePaths(rootDir);
  const resolvedPath = path.resolve(rootDir, requestedPath || defaultPath);
  const relative = path.relative(paths.candidateDir, resolvedPath);
  if (resolvedPath === paths.publicManifestPath) throw new Error('BASE_QA_CANDIDATE_PUBLIC_PATH');
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('BASE_QA_CANDIDATE_PATH');
  return resolvedPath;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Manifest(manifest) {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
}

export function validateCandidateManifest(input, candidatePath, rootDir) {
  assertCandidateManifestPath(candidatePath, rootDir);
  let manifest;
  try {
    manifest = parseBaseDeploymentManifest(input, BASE_QA_RELEASE_TARGET);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BASE_MANIFEST_')) throw error;
    throw new Error('BASE_QA_CANDIDATE_MANIFEST');
  }
  if (Object.hasOwn(input ?? {}, 'releaseCandidate') && input.releaseCandidate !== true) {
    throw new Error('BASE_QA_CANDIDATE_MANIFEST');
  }
  if (positiveInteger(input?.blockNumber) === undefined) throw new Error('BASE_QA_CANDIDATE_MANIFEST');
  return manifest;
}

export async function readCandidateManifest(rootDir, requestedPath) {
  const resolvedPath = resolveCandidateManifestPath(rootDir, requestedPath);
  let input;
  try {
    input = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('BASE_QA_CANDIDATE_REQUIRED');
    if (error instanceof SyntaxError) throw new Error('BASE_QA_CANDIDATE_JSON');
    throw error;
  }
  validateCandidateManifest(input, resolvedPath, rootDir);
  return {
    manifest: input,
    candidatePath: resolvedPath,
    candidateSha256: sha256Manifest(input),
  };
}

export function validateCandidateAccounts(manifest, expectedAccounts) {
  const expected = normalizeExpectedAccounts(expectedAccounts);
  for (const role of ['operator', 'depositor', 'lp']) {
    if (!expected[role] || !sameAddress(manifest?.roles?.[role], expected[role])) {
      throw new Error(`BASE_QA_CANDIDATE_ACCOUNT_MISMATCH:${role}`);
    }
  }
  return expected;
}

export function validateSmokeEvidence(proof, candidate, candidateSha256 = sha256Manifest(candidate)) {
  if (proof?.candidateSha256 !== candidateSha256) throw new Error('BASE_QA_SMOKE_PROOF_CANDIDATE_MISMATCH');
  if (
    !isPlainObject(proof)
    || proof.schemaVersion !== BASE_QA_RELEASE_SCHEMA_VERSION
    || proof.kind !== 'base-sepolia-smoke'
    || proof.target !== BASE_QA_RELEASE_TARGET
    || proof.chainId !== BASE_SEPOLIA_CHAIN_ID
    || proof.checks !== 35
    || proof.productionEligible !== false
    || !sameAddress(proof.nativeUsdc, candidate?.nativeUsdc)
    || !sameAddress(proof.addresses?.router, candidate?.addresses?.router)
    || !sameAddress(proof.addresses?.settlement, candidate?.addresses?.settlement)
    || !sameAddress(proof.addresses?.facility, candidate?.addresses?.facility)
  ) throw new Error('BASE_QA_SMOKE_PROOF_INVALID');
  return proof;
}

export function validateDepositEvidence(proof, candidate, candidateSha256 = sha256Manifest(candidate), expectedAccounts) {
  if (proof?.candidateSha256 !== candidateSha256) throw new Error('BASE_QA_DEPOSIT_PROOF_CANDIDATE_MISMATCH');
  if (!proof?.approval) throw new Error('BASE_QA_APPROVAL_EVENT_MISSING');
  if (!proof?.deposit) throw new Error('BASE_QA_DEPOSIT_EVENT_MISSING');
  const expectedDepositor = normalizeExpectedAccounts(expectedAccounts).depositor || candidate?.roles?.depositor;
  const validEnvelope = (
    isPlainObject(proof)
    && proof.schemaVersion === BASE_QA_RELEASE_SCHEMA_VERSION
    && proof.kind === 'base-sepolia-deposit'
    && proof.target === BASE_QA_RELEASE_TARGET
    && proof.chainId === BASE_SEPOLIA_CHAIN_ID
    && sameAddress(proof.nativeUsdc, BASE_SEPOLIA_NATIVE_USDC)
    && sameAddress(proof.nativeUsdc, candidate?.nativeUsdc)
    && sameAddress(proof.facility, candidate?.addresses?.facility)
    && sameAddress(proof.depositor, expectedDepositor)
  );
  if (!validEnvelope) throw new Error('BASE_QA_DEPOSIT_PROOF_INVALID');

  const approval = proof.approval;
  const deposit = proof.deposit;
  const approvalValue = positiveInteger(approval.value);
  const depositAssets = positiveInteger(deposit.assets);
  const depositShares = positiveInteger(deposit.shares);
  const sharesBefore = nonnegativeInteger(proof.sharesBefore);
  const sharesAfter = positiveInteger(proof.sharesAfter);
  const validApproval = (
    approval.eventName === 'Approval'
    && sameAddress(approval.logAddress, candidate.nativeUsdc)
    && sameAddress(approval.owner, expectedDepositor)
    && sameAddress(approval.spender, candidate.addresses.facility)
    && validOptionalReceiptFrom(approval.receiptFrom)
    && approvalValue !== undefined
  );
  if (!validApproval) throw new Error('BASE_QA_DEPOSIT_PROOF_INVALID');
  const validDeposit = (
    deposit.eventName === 'Deposit'
    && sameAddress(deposit.logAddress, candidate.addresses.facility)
    && sameAddress(deposit.sender, expectedDepositor)
    && sameAddress(deposit.owner, expectedDepositor)
    && validOptionalReceiptFrom(deposit.receiptFrom)
    && depositAssets !== undefined
    && depositShares !== undefined
  );
  if (!validDeposit) throw new Error('BASE_QA_DEPOSIT_PROOF_INVALID');
  if (
    approvalValue < depositAssets
    || sharesBefore === undefined
    || sharesAfter === undefined
    || sharesAfter <= sharesBefore
    || !validTransactionHash(approval.transactionHash)
    || !validTransactionHash(deposit.transactionHash)
    || !positiveInteger(approval.blockNumber)
    || !positiveInteger(deposit.blockNumber)
    || positiveInteger(candidate?.blockNumber) === undefined
    || BigInt(approval.blockNumber) < BigInt(candidate.blockNumber)
    || BigInt(deposit.blockNumber) < BigInt(candidate.blockNumber)
    || BigInt(deposit.blockNumber) < BigInt(approval.blockNumber)
  ) throw new Error('BASE_QA_DEPOSIT_PROOF_INVALID');
  return proof;
}

/**
 * Validate the complete, candidate-bound Base Sepolia stock-sale canary.
 *
 * The proof is intentionally checked independently of the API.  It is the
 * release gate's durable assertion that the exact B20 and native-USDC amounts
 * moved between the expected seller/maker accounts, that the router and
 * settlement contracts retained no dust, and that the quote was simulated at
 * the server-owned decision/simulation blocks.
 */
export function validateStockSaleEvidence(
  proof,
  candidate,
  candidateSha256 = sha256Manifest(candidate),
  expectedAccounts,
) {
  if (proof?.candidateSha256 !== candidateSha256) throw new Error('BASE_QA_SWAP_PROOF_CANDIDATE_MISMATCH');
  const proofSettlementAddress = typeof proof?.settlement === 'string'
    ? proof.settlement
    : proof?.settlementAddress ?? proof?.settlementEvent?.logAddress ?? proof?.settlement?.logAddress;
  if (!isPlainObject(proof)
    || proof.schemaVersion !== BASE_SEPOLIA_STOCK_SALE_PROOF_SCHEMA_VERSION
    || proof.kind !== 'base-sepolia-stock-sale'
    || proof.target !== BASE_QA_RELEASE_TARGET
    || proof.chainId !== BASE_SEPOLIA_CHAIN_ID
    || !sameAddress(proof.stockToken, candidate?.addresses?.mockB20)
    || !sameAddress(proof.nativeUsdc, candidate?.nativeUsdc)
    || !sameAddress(proof.router, candidate?.addresses?.router)
    || !sameAddress(proofSettlementAddress, candidate?.addresses?.settlement)) {
    throw new Error('BASE_QA_SWAP_PROOF_INVALID');
  }

  const expected = normalizeExpectedAccounts(expectedAccounts);
  const seller = proof.seller ?? proof.roles?.seller ?? expected.depositor ?? candidate?.roles?.depositor;
  const maker = proof.maker ?? proof.roles?.maker ?? expected.lp ?? candidate?.roles?.lp;
  if (!sameAddress(seller, expected.depositor ?? candidate?.roles?.depositor)
    || !sameAddress(maker, expected.lp ?? candidate?.roles?.lp)) {
    throw new Error('BASE_QA_SWAP_PROOF_ROLES');
  }

  const stockAmount = positiveInteger(proof.stockAmount);
  const usdcAmount = positiveInteger(proof.usdcAmount);
  if (stockAmount === undefined || usdcAmount === undefined) throw new Error('BASE_QA_SWAP_PROOF_AMOUNTS');
  for (const field of ['requestId', 'routeId', 'orderHash', 'decisionBlockHash', 'simulationBlockHash']) {
    if (!validTransactionHash(proof[field])) throw new Error('BASE_QA_SWAP_PROOF_INVALID_HASH');
  }
  const decisionBlock = positiveInteger(proof.decisionBlock);
  const simulationBlock = positiveInteger(proof.simulationBlock);
  const candidateBlock = positiveInteger(candidate?.blockNumber);
  if (decisionBlock === undefined || simulationBlock === undefined || candidateBlock === undefined
    || decisionBlock >= simulationBlock) throw new Error('BASE_QA_SWAP_PROOF_BLOCK_ORDER');

  const approval = proof.approval ?? proof.events?.approval;
  const swapFilled = proof.settlementEvent
    ?? proof.events?.swapFilled
    ?? proof.events?.settlementEvent
    ?? (isPlainObject(proof.settlement) ? proof.settlement : undefined);
  const routeFilled = proof.routeEvent
    ?? proof.events?.routeFilled
    ?? proof.events?.routeEvent
    ?? (isPlainObject(proof.route) ? proof.route : undefined);
  const approvalReceipt = proof.approvalReceipt ?? proof.receipts?.approval;
  const settlementReceipt = proof.settlementReceipt ?? proof.receipts?.settlement;
  if (!approval || !swapFilled || !routeFilled || !approvalReceipt || !settlementReceipt) {
    throw new Error('BASE_QA_SWAP_PROOF_EVENTS_MISSING');
  }
  assertStockSaleReceipt(approvalReceipt, 'approval');
  assertStockSaleReceipt(settlementReceipt, 'settlement');
  if (approvalReceipt.status !== undefined && !successfulReceiptStatus(approvalReceipt.status)) {
    throw new Error('BASE_QA_SWAP_PROOF_RECEIPT');
  }
  if (settlementReceipt.status !== undefined && !successfulReceiptStatus(settlementReceipt.status)) {
    throw new Error('BASE_QA_SWAP_PROOF_RECEIPT');
  }

  const validApprovalEvent = approval.eventName === 'Approval'
    && sameAddress(approval.logAddress ?? approval.address, candidate.addresses.mockB20)
    && sameAddress(approval.owner, seller)
    && sameAddress(approval.spender, candidate.addresses.settlement)
    && positiveInteger(approval.value) === stockAmount
    && validTransactionHash(approval.transactionHash)
    && sameHash(approval.transactionHash, approvalReceipt.transactionHash)
    && positiveInteger(approval.blockNumber) === positiveInteger(approvalReceipt.blockNumber);
  const validApprovalCall = approval.eventName === 'ApprovalCall'
    && approval.evidence === 'receipt-input'
    && approval.functionName === 'approve'
    && sameAddress(approval.logAddress ?? approval.address, candidate.addresses.mockB20)
    && sameAddress(approval.transactionFrom, seller)
    && sameAddress(approval.transactionTo, candidate.addresses.mockB20)
    && sameAddress(approval.owner, seller)
    && sameAddress(approval.spender, candidate.addresses.settlement)
    && positiveInteger(approval.value) === stockAmount
    && validApprovalCallData(approval.callData, candidate.addresses.settlement, stockAmount)
    && validTransactionHash(approval.transactionHash)
    && sameHash(approval.transactionHash, approvalReceipt.transactionHash)
    && positiveInteger(approval.blockNumber) === positiveInteger(approvalReceipt.blockNumber);
  const validApproval = validApprovalEvent || validApprovalCall;
  if (!validApproval) throw new Error('BASE_QA_SWAP_PROOF_APPROVAL');

  const settlementStock = positiveInteger(swapFilled.stockAmount ?? swapFilled.totalStock);
  const settlementUsdc = positiveInteger(swapFilled.usdcAmount ?? swapFilled.boughtUsdc);
  const validSettlement = swapFilled.eventName === 'SwapFilled'
    && sameAddress(swapFilled.logAddress ?? swapFilled.address, candidate.addresses.settlement)
    && sameAddress(swapFilled.maker, maker)
    && sameAddress(swapFilled.taker, seller)
    && sameAddress(swapFilled.stockToken, candidate.addresses.mockB20)
    && sameAddress(swapFilled.usdcToken, candidate.nativeUsdc)
    && sameHash(swapFilled.orderHash, proof.orderHash)
    && settlementStock === stockAmount
    && settlementUsdc === usdcAmount
    && validTransactionHash(swapFilled.transactionHash)
    && sameHash(swapFilled.transactionHash, settlementReceipt.transactionHash)
    && positiveInteger(swapFilled.blockNumber) === positiveInteger(settlementReceipt.blockNumber);
  if (!validSettlement) throw new Error('BASE_QA_SWAP_PROOF_SETTLEMENT');

  const routeStock = positiveInteger(routeFilled.totalStock ?? routeFilled.stockAmount);
  const routeUsdc = positiveInteger(routeFilled.boughtUsdc ?? routeFilled.usdcAmount);
  const validRoute = routeFilled.eventName === 'SwapRouteFilled'
    && sameAddress(routeFilled.logAddress ?? routeFilled.address, candidate.addresses.router)
    && sameAddress(routeFilled.taker, seller)
    && sameAddress(routeFilled.recipient ?? seller, seller)
    && sameAddress(routeFilled.stockToken, candidate.addresses.mockB20)
    && sameAddress(routeFilled.usdcToken, candidate.nativeUsdc)
    && sameHash(routeFilled.requestId, proof.requestId)
    && routeStock === stockAmount
    && routeUsdc === usdcAmount
    && validTransactionHash(routeFilled.transactionHash)
    && sameHash(routeFilled.transactionHash, settlementReceipt.transactionHash)
    && positiveInteger(routeFilled.blockNumber) === positiveInteger(settlementReceipt.blockNumber);
  if (!validRoute) throw new Error('BASE_QA_SWAP_PROOF_ROUTE');

  const approvalBlock = positiveInteger(approval.blockNumber ?? approvalReceipt.blockNumber);
  const settlementBlock = positiveInteger(swapFilled.blockNumber ?? routeFilled.blockNumber ?? settlementReceipt.blockNumber);
  if (approvalBlock === undefined || settlementBlock === undefined
    || approvalBlock < candidateBlock
    || approvalBlock > decisionBlock
    || settlementBlock < simulationBlock
    || settlementBlock < decisionBlock
    || positiveInteger(approvalReceipt.blockNumber) !== approvalBlock
    || positiveInteger(settlementReceipt.blockNumber) !== settlementBlock) {
    throw new Error('BASE_QA_SWAP_PROOF_BLOCK_ORDER');
  }

  validateStockSaleBalances(proof, seller, maker, stockAmount, usdcAmount);
  if (nonnegativeInteger(proof.remainingSellerStockAllowance ?? proof.remainingStockAllowance) !== 0n) {
    throw new Error('BASE_QA_SWAP_PROOF_ALLOWANCE');
  }
  const dust = proof.dust;
  for (const field of ['routerStock', 'routerUsdc', 'settlementStock', 'settlementUsdc']) {
    if (nonnegativeInteger(dust?.[field]) !== 0n) throw new Error('BASE_QA_SWAP_PROOF_DUST');
  }
  return proof;
}

// Keep the shorter name available to callers that model this as a swap proof.
export const validateSwapEvidence = validateStockSaleEvidence;

export function validatePromotionEvidence({
  candidate,
  candidatePath,
  rootDir,
  smoke,
  deposit,
  swap,
  candidateSha256 = sha256Manifest(candidate),
  expectedAccounts,
  publicManifestPath = candidatePaths(rootDir).publicManifestPath,
}) {
  assertCandidateManifestPath(candidatePath, rootDir);
  validateCandidateManifest(candidate, candidatePath, rootDir);
  if (publicManifestPath !== candidatePaths(rootDir).publicManifestPath) throw new Error('BASE_QA_PROMOTION_PATH');
  if (candidateSha256 !== sha256Manifest(candidate)) throw new Error('BASE_QA_CANDIDATE_DIGEST_INVALID');
  validateCandidateAccounts(candidate, expectedAccounts);
  validateSmokeEvidence(smoke, candidate, candidateSha256);
  validateDepositEvidence(deposit, candidate, candidateSha256, expectedAccounts);
  // Every promotion must carry the versioned M5 stock-sale proof.  The
  // candidate flag remains useful metadata, but cannot disable the gate.
  if (!swap) throw new Error('BASE_QA_SWAP_PROOF_REQUIRED');
  validateStockSaleEvidence(swap, candidate, candidateSha256, expectedAccounts);
  return { candidateSha256, chainId: BASE_SEPOLIA_CHAIN_ID, publicManifestPath };
}

export async function promoteReleaseCandidate({
  rootDir,
  candidatePath,
  smokeProofPath,
  depositProofPath,
  swapProofPath,
  expectedAccounts,
}) {
  const paths = candidatePaths(rootDir);
  const candidate = await readCandidateManifest(rootDir, candidatePath);
  const smoke = await readProof(resolveCandidateEvidencePath(rootDir, smokeProofPath, paths.smokeProofPath), 'BASE_QA_SMOKE_PROOF_REQUIRED');
  const deposit = await readProof(resolveCandidateEvidencePath(rootDir, depositProofPath, paths.depositProofPath), 'BASE_QA_DEPOSIT_PROOF_REQUIRED');
  const swap = await readProof(
    resolveCandidateEvidencePath(rootDir, swapProofPath, paths.swapProofPath),
    'BASE_QA_SWAP_PROOF_REQUIRED',
  );
  const result = validatePromotionEvidence({
    candidate: candidate.manifest,
    candidatePath: candidate.candidatePath,
    rootDir,
    smoke,
    deposit,
    swap,
    candidateSha256: candidate.candidateSha256,
    expectedAccounts,
    publicManifestPath: paths.publicManifestPath,
  });
  await writeJsonAtomically(paths.publicManifestPath, candidate.manifest);
  return result;
}

export function parseReleasePathArg(argv, name) {
  const equals = argv.find((value) => value.startsWith(`${name}=`));
  const separated = argv.indexOf(name);
  return equals?.slice(name.length + 1) ?? (separated >= 0 ? argv[separated + 1] : undefined);
}

async function readProof(filePath, missingCode) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(missingCode);
    if (error instanceof SyntaxError) throw new Error('BASE_QA_RELEASE_EVIDENCE_JSON');
    throw error;
  }
}

async function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error(`BASE_QA_PROMOTION_ATOMIC:${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('BASE_QA_MANIFEST_HASH');
    return value;
  }
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  throw new Error('BASE_QA_MANIFEST_HASH');
}

function normalizeExpectedAccounts(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.filter((entry) => entry?.role).map((entry) => [entry.role, entry.address]));
  }
  return value && typeof value === 'object' ? value : {};
}

function positiveInteger(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return undefined;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nonnegativeInteger(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return undefined;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validTransactionHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function validOptionalReceiptFrom(value) {
  return value === undefined || (typeof value === 'string' && isAddress(value));
}

function assertStockSaleReceipt(receipt, kind) {
  if (!isPlainObject(receipt)
    || !validTransactionHash(receipt.transactionHash)
    || positiveInteger(receipt.blockNumber) === undefined) {
    throw new Error(`BASE_QA_SWAP_PROOF_${kind.toUpperCase()}_RECEIPT`);
  }
}

function successfulReceiptStatus(status) {
  return status === 'success' || status === '0x1' || status === 1 || status === true;
}

function sameHash(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && validTransactionHash(left) && validTransactionHash(right)
    && left.toLowerCase() === right.toLowerCase();
}

function validApprovalCallData(value, spender, amount) {
  if (typeof value !== 'string' || !/^0x095ea7b3[0-9a-fA-F]{128}$/u.test(value)) return false;
  const encodedSpender = value.slice(10, 74);
  const encodedAmount = `0x${value.slice(74)}`;
  // ABI address arguments are left-padded to a full word. Checking only the
  // low 20 bytes would accept calldata that is not a canonical approve call.
  if (!/^0{24}[0-9a-fA-F]{40}$/u.test(encodedSpender)) return false;
  let decodedAmount;
  try { decodedAmount = BigInt(encodedAmount); } catch { return false; }
  return encodedSpender.slice(-40).toLowerCase() === spender.slice(2).toLowerCase() && decodedAmount === amount;
}

function validateStockSaleBalances(proof, seller, maker, stockAmount, usdcAmount) {
  const before = proof.balancesBefore;
  const after = proof.balancesAfter;
  if (!isPlainObject(before) || !isPlainObject(after)) throw new Error('BASE_QA_SWAP_PROOF_BALANCES');
  const read = (balances, role, asset) => {
    const entry = balances[role];
    const value = entry?.[asset]
      ?? (asset === 'stock' ? entry?.stockToken : entry?.usdcToken)
      ?? (asset === 'stock' ? entry?.b20 : entry?.nativeUsdc);
    return nonnegativeInteger(value);
  };
  const sellerBeforeStock = read(before, 'seller', 'stock');
  const sellerAfterStock = read(after, 'seller', 'stock');
  const makerBeforeStock = read(before, 'maker', 'stock');
  const makerAfterStock = read(after, 'maker', 'stock');
  const sellerBeforeUsdc = read(before, 'seller', 'usdc');
  const sellerAfterUsdc = read(after, 'seller', 'usdc');
  const makerBeforeUsdc = read(before, 'maker', 'usdc');
  const makerAfterUsdc = read(after, 'maker', 'usdc');
  if ([sellerBeforeStock, sellerAfterStock, makerBeforeStock, makerAfterStock,
    sellerBeforeUsdc, sellerAfterUsdc, makerBeforeUsdc, makerAfterUsdc].some((value) => value === undefined)
    || sellerBeforeStock - sellerAfterStock !== stockAmount
    || makerAfterStock - makerBeforeStock !== stockAmount
    || sellerAfterUsdc - sellerBeforeUsdc !== usdcAmount
    || makerBeforeUsdc - makerAfterUsdc !== usdcAmount) {
    throw new Error('BASE_QA_SWAP_PROOF_BALANCES');
  }

  for (const role of ['router', 'settlement']) {
    for (const asset of ['stock', 'usdc']) {
      const beforeValue = read(before, role, asset);
      const afterValue = read(after, role, asset);
      if (beforeValue === undefined || afterValue === undefined || beforeValue !== afterValue) {
        throw new Error('BASE_QA_SWAP_PROOF_DUST');
      }
    }
  }
  // Keep the address fields in the proof useful to human auditors and reject
  // proofs that silently relabel the role balances.
  if (proof.balanceAddresses && (!sameAddress(proof.balanceAddresses.seller, seller)
    || !sameAddress(proof.balanceAddresses.maker, maker))) {
    throw new Error('BASE_QA_SWAP_PROOF_ROLES');
  }
}

function sameAddress(left, right) {
  try {
    return typeof left === 'string' && typeof right === 'string' && isAddress(left) && isAddress(right) && getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
