import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createPublicClient, http } from 'viem';

import {
  BASE_SEPOLIA_CHAIN_ID,
  assertBaseDeploymentTarget,
} from './base-deployment-lib.mjs';
import {
  assertNonstandardQaWallet,
  deriveBaseQaAccounts,
  parseEnvContents,
  targetQaConfig,
  validateBaseQaSecrets,
} from './base-qa-lib.mjs';
import {
  buildBaseSepoliaDepositProof,
  selectBaseSepoliaEvent,
} from './base-sepolia-deposit-lib.mjs';
import {
  candidatePaths,
  parseReleasePathArg,
  readCandidateManifest,
  validateCandidateAccounts,
} from './base-release-gate-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  await main();
} catch (error) {
  console.error(`base-qa-deposit=FAIL reason=${stableReason(error)}`);
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const environment = await readEnvironment();
  const secrets = validateBaseQaSecrets(environment);
  const config = targetQaConfig('sepolia', environment);
  const accounts = deriveBaseQaAccounts(secrets.mnemonic);
  assertNonstandardQaWallet(accounts);
  const expectedAccounts = Object.fromEntries(accounts.map((entry) => [entry.role, entry.address]));
  const candidate = await readCandidateManifest(rootDir, parseReleasePathArg(argv, '--candidate'));
  validateCandidateAccounts(candidate.manifest, expectedAccounts);
  const candidateBlock = positiveBlock(candidate.manifest.blockNumber);
  const client = createPublicClient({
    chain: {
      id: BASE_SEPOLIA_CHAIN_ID,
      name: 'Base Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    },
    transport: http(config.rpcUrl, { timeout: 30_000, retryCount: 1 }),
  });
  const chainId = await client.getChainId();
  assertBaseDeploymentTarget({ target: 'sepolia', rpcUrl: config.rpcUrl, chainId });

  const approvalTx = parseReleasePathArg(argv, '--approval-tx');
  const depositTx = parseReleasePathArg(argv, '--deposit-tx');
  const approvalSource = await readLogs(client, approvalTx, candidate.manifest.nativeUsdc, candidateBlock, 'approval');
  const depositSource = await readLogs(client, depositTx, candidate.manifest.addresses.facility, candidateBlock, 'deposit');
  const approval = selectBaseSepoliaEvent(approvalSource.logs, 'approval', {
    candidate: candidate.manifest,
    depositor: accounts[1].address,
    transactionFrom: approvalSource.transactionFrom,
  });
  if (!approval) throw new Error('BASE_QA_APPROVAL_EVENT_MISSING');
  const deposit = selectBaseSepoliaEvent(depositSource.logs, 'deposit', {
    candidate: candidate.manifest,
    depositor: accounts[1].address,
    transactionFrom: depositSource.transactionFrom,
  });
  if (!deposit) throw new Error('BASE_QA_DEPOSIT_EVENT_MISSING');
  if (BigInt(approval.blockNumber) < candidateBlock || BigInt(deposit.blockNumber) < candidateBlock) {
    throw new Error('BASE_QA_DEPOSIT_PROOF_INVALID');
  }

  const facilityAbi = [{
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  }];
  const depositBlock = BigInt(deposit.blockNumber);
  if (depositBlock === 0n) throw new Error('BASE_QA_DEPOSIT_PROOF_INVALID');
  const sharesBefore = await client.readContract({
    address: candidate.manifest.addresses.facility,
    abi: facilityAbi,
    functionName: 'balanceOf',
    args: [accounts[1].address],
    blockNumber: depositBlock - 1n,
  });
  const sharesAfter = await client.readContract({
    address: candidate.manifest.addresses.facility,
    abi: facilityAbi,
    functionName: 'balanceOf',
    args: [accounts[1].address],
    blockNumber: depositBlock,
  });
  const proof = buildBaseSepoliaDepositProof({
    candidate: candidate.manifest,
    candidateSha256: candidate.candidateSha256,
    depositor: accounts[1].address,
    approvalLogs: approvalSource.logs,
    depositLogs: depositSource.logs,
    approvalFrom: approvalSource.transactionFrom,
    depositFrom: depositSource.transactionFrom,
    sharesBefore,
    sharesAfter,
  });
  const outputPath = candidatePaths(rootDir, 'sepolia').depositProofPath;
  await writeProof(outputPath, proof);
  console.log(`base-qa-deposit=PASS chainId=${chainId} candidateSha256=${candidate.candidateSha256} depositor=${accounts[1].address} approvalTx=${proof.approval.transactionHash} depositTx=${proof.deposit.transactionHash} assets=${proof.deposit.assets} shares=${proof.deposit.shares} sharesBefore=${proof.sharesBefore} sharesAfter=${proof.sharesAfter} proof=${path.relative(rootDir, outputPath)}`);
}

async function readLogs(client, transactionHash, eventAddress, candidateBlock, kind) {
  if (transactionHash !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)) throw new Error('BASE_QA_DEPOSIT_TX_INVALID');
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== 'success') throw new Error(`BASE_QA_${kind.toUpperCase()}_TX_FAILED`);
    if (receipt.blockNumber < candidateBlock) throw new Error('BASE_QA_DEPOSIT_PROOF_INVALID');
    return { logs: receipt.logs, transactionFrom: receipt.from };
  }
  const logs = await client.getLogs({ address: eventAddress, fromBlock: candidateBlock });
  return { logs, transactionFrom: undefined };
}

async function readEnvironment() {
  let fileEnvironment = {};
  try {
    fileEnvironment = parseEnvContents(await fs.readFile(path.join(rootDir, '.env.base-qa.local'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...fileEnvironment, ...process.env };
}

async function writeProof(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error('BASE_QA_DEPOSIT_PROOF_WRITE');
  }
}

function positiveBlock(value) {
  try {
    const block = BigInt(value);
    if (block > 0n) return block;
  } catch {
    // Stable validation error below.
  }
  throw new Error('BASE_QA_CANDIDATE_MANIFEST');
}

function stableReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^BASE_[A-Z0-9_:-]+$/u.test(message)) return message;
  if (message.startsWith('BASE_QA_')) return message.split(':', 1)[0];
  return 'BASE_QA_DEPOSIT_RPC';
}
