import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  stringToHex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

import { BASE_SEPOLIA_CHAIN_ID } from './base-deployment-lib.mjs';
import { parseEnvContents, deriveBaseQaAccounts, assertNonstandardQaWallet } from './base-qa-lib.mjs';
import { candidatePaths, readCandidateManifest } from './base-release-gate-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proofPath = path.join(candidatePaths(rootDir).candidateDir, 'redemption-proof.json');
const STOCK_AMOUNT = 10n ** 8n;
const FACILITY_COST = 900_000n;
const REDEMPTION_PROCEEDS = 1_000_000n;
const USDC_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const STOCK_ABI = [
  ...USDC_ABI,
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
];
const FACILITY_ABI = [
  ...USDC_ABI,
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
  { type: 'function', name: 'setStockPrice', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'priceWad_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setStockPriceMaxAge', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'maxAge', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setStockMultiplier', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'multiplierWad_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setStockExposureCap', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'cap', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setRedemptionPath', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'enabled', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'quote', stateMutability: 'view', inputs: [{ name: 'stockToken', type: 'address' }, { name: 'stockAmount', type: 'uint256' }], outputs: [{ name: 'usdcAmount', type: 'uint256' }, { name: 'capacity', type: 'uint256' }, { name: 'expiry', type: 'uint256' }] },
  { type: 'function', name: 'nextRedemptionLotId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'redemptionLots', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'acquisitionCost', type: 'uint256' }, { name: 'operator', type: 'address' }, { name: 'settled', type: 'bool' }] },
  { type: 'function', name: 'settleRedemption', stateMutability: 'nonpayable', inputs: [{ name: 'redemptionLotId', type: 'uint256' }, { name: 'usdcProceeds', type: 'uint256' }], outputs: [{ name: 'realizedPnl', type: 'int256' }] },
  { type: 'function', name: 'stockExposure', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'realizedProfit', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'realizedLoss', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'inventoryAtAcquisitionCost', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];
const ROUTER_ABI = [{
  type: 'function', name: 'executeSwapRoute', stateMutability: 'nonpayable',
  inputs: [
    { name: 'plan', type: 'tuple', components: [
      { name: 'requestId', type: 'bytes32' }, { name: 'taker', type: 'address' }, { name: 'recipient', type: 'address' },
      { name: 'stockToken', type: 'address' }, { name: 'usdcToken', type: 'address' }, { name: 'settlement', type: 'address' },
      { name: 'sellAmount', type: 'uint256' }, { name: 'minBuyAmount', type: 'uint256' }, { name: 'feeCapBps', type: 'uint16' },
      { name: 'deadline', type: 'uint256' }, { name: 'decisionBlock', type: 'uint256' }, { name: 'decisionBlockHash', type: 'bytes32' },
    ] },
    { name: 'legs', type: 'tuple[]', components: [
      { name: 'source', type: 'uint8' }, { name: 'liquidity', type: 'address' }, { name: 'stockAmount', type: 'uint256' },
      { name: 'minUsdcOut', type: 'uint256' }, { name: 'payload', type: 'bytes' },
    ] },
  ], outputs: [{ name: 'boughtUsdc', type: 'uint256' }, { name: 'fee', type: 'uint256' }],
}];

try {
  await main();
} catch (error) {
  console.error(`qa-base-redemption=FAIL reason=${stableReason(error)}`);
  process.exitCode = 1;
}

async function main() {
  const env = parseEnvContents(await fs.readFile(path.join(rootDir, '.env.base-qa.local'), 'utf8'));
  const mnemonic = env.BASE_QA_MNEMONIC?.trim().replace(/\s+/gu, ' ');
  if (!mnemonic) throw new Error('BASE_QA_MNEMONIC');
  const candidate = await readCandidateManifest(rootDir);
  const stockToken = getAddress(candidate.manifest.addresses.mockB20);
  const facility = getAddress(candidate.manifest.addresses.facility);
  const router = getAddress(candidate.manifest.addresses.router);
  const settlement = getAddress(candidate.manifest.addresses.settlement);
  const usdcToken = getAddress(candidate.manifest.nativeUsdc);
  const roles = deriveBaseQaAccounts(mnemonic);
  assertNonstandardQaWallet(roles);
  const operator = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  const curator = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  const seller = mnemonicToAccount(mnemonic, { addressIndex: 2 });
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org';
  const chain = { id: BASE_SEPOLIA_CHAIN_ID, name: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }) });
  const wallets = [operator, curator, seller].map((account) => createWalletClient({ account, chain, transport: http(rpcUrl) }));
  const [operatorWallet, curatorWallet, sellerWallet] = wallets;
  const operatorAddress = getAddress(operator.address);
  const curatorAddress = getAddress(curator.address);
  const sellerAddress = getAddress(seller.address);
  if (Number(await client.readContract({ address: stockToken, abi: STOCK_ABI, functionName: 'decimals' })) !== 8) throw new Error('BASE_QA_STOCK_DECIMALS');

  const setup = [];
  let routeReceipt;
  let routeHash;
  let lotId;
  let requestId;
  const nextLotId = await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'nextRedemptionLotId' });
  if (nextLotId === 0n) {
    setup.push(await send(curatorWallet, client, facility, FACILITY_ABI, 'setStockPrice', [stockToken, 9n * 10n ** 15n]));
    setup.push(await send(curatorWallet, client, facility, FACILITY_ABI, 'setStockPriceMaxAge', [stockToken, 86_400n]));
    setup.push(await send(curatorWallet, client, facility, FACILITY_ABI, 'setStockMultiplier', [stockToken, 10n ** 18n]));
    setup.push(await send(curatorWallet, client, facility, FACILITY_ABI, 'setStockExposureCap', [stockToken, STOCK_AMOUNT]));
    setup.push(await send(curatorWallet, client, facility, FACILITY_ABI, 'setRedemptionPath', [stockToken, operatorAddress, true]));
    setup.push(await send(curatorWallet, client, usdcToken, USDC_ABI, 'approve', [facility, FACILITY_COST]));
    setup.push(await send(curatorWallet, client, facility, FACILITY_ABI, 'deposit', [FACILITY_COST, curatorAddress]));
    setup.push(await send(curatorWallet, client, usdcToken, USDC_ABI, 'transfer', [operatorAddress, REDEMPTION_PROCEEDS - FACILITY_COST]));
    setup.push(await send(sellerWallet, client, stockToken, STOCK_ABI, 'mint', [sellerAddress, STOCK_AMOUNT]));
    setup.push(await send(sellerWallet, client, stockToken, STOCK_ABI, 'approve', [router, STOCK_AMOUNT]));

    const quote = await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'quote', args: [stockToken, STOCK_AMOUNT] });
    const quotedUsdc = quote.usdcAmount ?? quote[0];
    const capacity = quote.capacity ?? quote[1];
    const expiry = quote.expiry ?? quote[2];
    if (quotedUsdc !== FACILITY_COST || capacity < STOCK_AMOUNT || expiry <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('BASE_QA_FACILITY_QUOTE');

    const decision = await client.getBlock({ blockTag: 'latest' });
    if (decision.number === undefined || decision.hash === undefined || decision.timestamp === undefined) throw new Error('BASE_QA_DECISION_BLOCK');
    requestId = keccak256(stringToHex(`KATON_CONTROLLED_QA_REDEMPTION_${candidate.candidateSha256}_${Date.now()}`));
    const payload = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [keccak256(stringToHex(`CONTROLLED_QA_REDEMPTION_${requestId}`)), quotedUsdc, STOCK_AMOUNT, expiry],
    );
    const plan = {
      requestId,
      taker: sellerAddress,
      recipient: sellerAddress,
      stockToken,
      usdcToken,
      settlement,
      sellAmount: STOCK_AMOUNT,
      minBuyAmount: FACILITY_COST,
      feeCapBps: 0,
      deadline: decision.timestamp + 300n,
      decisionBlock: decision.number,
      decisionBlockHash: decision.hash,
    };
    routeHash = await sellerWallet.writeContract({ address: router, abi: ROUTER_ABI, functionName: 'executeSwapRoute', args: [plan, [{ source: 1, liquidity: facility, stockAmount: STOCK_AMOUNT, minUsdcOut: FACILITY_COST, payload }]], account: seller });
    routeReceipt = await waitSuccess(client, routeHash, 'BASE_QA_REDEMPTION_PURCHASE');
    lotId = await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'nextRedemptionLotId' }) - 1n;
  } else if (nextLotId === 1n) {
    lotId = 0n;
    const events = await client.getLogs({
      address: facility,
      event: parseAbiItem('event RedemptionLotBooked(uint256 indexed lotId, address indexed token, uint256 amount, uint256 acquisitionCost, address operator)'),
      args: { lotId },
      fromBlock: BigInt(candidate.manifest.blockNumber),
    });
    if (events.length !== 1) throw new Error('BASE_QA_EXISTING_PURCHASE_RECEIPT');
    routeHash = events[0].transactionHash;
    routeReceipt = await client.getTransactionReceipt({ hash: events[0].transactionHash });
  } else {
    throw new Error('BASE_QA_UNEXPECTED_REDEMPTION_STATE');
  }
  const lot = await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'redemptionLots', args: [lotId] });
  if ((lot.amount ?? lot[1]) !== STOCK_AMOUNT || (lot.acquisitionCost ?? lot[2]) !== FACILITY_COST || (lot.operator ?? lot[3]).toLowerCase() !== operatorAddress.toLowerCase()) throw new Error('BASE_QA_AUTO_BOOKING');

  let operatorApprovalHash;
  let settleHash;
  let settleReceipt;
  let balancesBeforeSettlement;
  if (lot.settled ?? lot[4]) {
    const settledLogs = await client.getLogs({
      address: facility,
      event: parseAbiItem('event RedemptionSettled(uint256 indexed lotId, uint256 usdcProceeds, int256 realizedPnl)'),
      args: { lotId },
      fromBlock: BigInt(candidate.manifest.blockNumber),
    });
    if (settledLogs.length !== 1) throw new Error('BASE_QA_EXISTING_SETTLEMENT_RECEIPT');
    settleHash = settledLogs[0].transactionHash;
    settleReceipt = await client.getTransactionReceipt({ hash: settleHash });
    const beforeBlock = settleReceipt.blockNumber - 1n;
    balancesBeforeSettlement = {
      sellerStock: await balanceAt(client, stockToken, sellerAddress, beforeBlock),
      sellerUsdc: await balanceAt(client, usdcToken, sellerAddress, beforeBlock),
      operatorUsdc: await balanceAt(client, usdcToken, operatorAddress, beforeBlock),
      facilityStock: await balanceAt(client, stockToken, facility, beforeBlock),
      facilityUsdc: await balanceAt(client, usdcToken, facility, beforeBlock),
      observedAtBlock: beforeBlock.toString(),
    };
    const approvals = await client.getLogs({
      address: usdcToken,
      event: parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)'),
      args: { owner: operatorAddress, spender: facility },
      fromBlock: BigInt(candidate.manifest.blockNumber),
      toBlock: settleReceipt.blockNumber,
    });
    operatorApprovalHash = approvals.at(-1)?.transactionHash;
  } else {
    const sellerProceeds = await balance(client, usdcToken, sellerAddress);
    const operatorBalance = await balance(client, usdcToken, operatorAddress);
    const fundingFromSeller = REDEMPTION_PROCEEDS - operatorBalance;
    if (fundingFromSeller > 0n) {
      if (sellerProceeds < fundingFromSeller) throw new Error('BASE_QA_OPERATOR_FUNDING');
      await send(sellerWallet, client, usdcToken, USDC_ABI, 'transfer', [operatorAddress, fundingFromSeller]);
    }
    balancesBeforeSettlement = {
      sellerStock: await balance(client, stockToken, sellerAddress),
      sellerUsdc: await balance(client, usdcToken, sellerAddress),
      operatorUsdc: await balance(client, usdcToken, operatorAddress),
      facilityStock: await balance(client, stockToken, facility),
      facilityUsdc: await balance(client, usdcToken, facility),
    };
    operatorApprovalHash = await send(operatorWallet, client, usdcToken, USDC_ABI, 'approve', [facility, REDEMPTION_PROCEEDS]);
    settleHash = await operatorWallet.writeContract({ address: facility, abi: FACILITY_ABI, functionName: 'settleRedemption', args: [lotId, REDEMPTION_PROCEEDS], account: operator });
    settleReceipt = await waitSuccess(client, settleHash, 'BASE_QA_REDEMPTION_SETTLEMENT');
  }
  const after = {
    sellerStock: await balance(client, stockToken, sellerAddress),
    sellerUsdc: await balance(client, usdcToken, sellerAddress),
    facilityStock: await balance(client, stockToken, facility),
    facilityUsdc: await balance(client, usdcToken, facility),
    operatorStock: await balance(client, stockToken, operatorAddress),
    operatorUsdc: await balance(client, usdcToken, operatorAddress),
    stockExposure: await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'stockExposure', args: [stockToken] }),
    realizedProfit: await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'realizedProfit' }),
    realizedLoss: await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'realizedLoss' }),
    inventoryAtAcquisitionCost: await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'inventoryAtAcquisitionCost' }),
  };
  const settledLot = await client.readContract({ address: facility, abi: FACILITY_ABI, functionName: 'redemptionLots', args: [lotId] });
  if (!settledLot.settled && !settledLot[4]) throw new Error('BASE_QA_REDEMPTION_NOT_SETTLED');
  const purchaseBlock = routeReceipt.blockNumber;
  const sellerBeforePurchase = {
    stock: await balanceAt(client, stockToken, sellerAddress, purchaseBlock - 1n),
    usdc: await balanceAt(client, usdcToken, sellerAddress, purchaseBlock - 1n),
  };
  const sellerAfterPurchase = {
    stock: await balanceAt(client, stockToken, sellerAddress, purchaseBlock),
    usdc: await balanceAt(client, usdcToken, sellerAddress, purchaseBlock),
  };
  if (sellerBeforePurchase.stock - sellerAfterPurchase.stock !== STOCK_AMOUNT || sellerAfterPurchase.usdc - sellerBeforePurchase.usdc !== FACILITY_COST || after.sellerStock !== 0n) throw new Error('BASE_QA_SELLER_DELTA');
  if (after.facilityStock !== 0n || after.facilityUsdc !== REDEMPTION_PROCEEDS || after.stockExposure !== 0n || after.inventoryAtAcquisitionCost !== 0n) throw new Error('BASE_QA_EXPOSURE_REDUCTION');
  if (after.realizedProfit !== REDEMPTION_PROCEEDS - FACILITY_COST || after.realizedLoss !== 0n) throw new Error('BASE_QA_REALIZED_PNL');

  const proof = {
    schemaVersion: 1,
    kind: 'controlled-qa-redemption',
    classification: 'CONTROLLED_QA_REDEMPTION',
    target: 'sepolia',
    chainId: BASE_SEPOLIA_CHAIN_ID,
    candidateSha256: candidate.candidateSha256,
    stockDecimals: 8,
    stockToken,
    nativeUsdc: usdcToken,
    router,
    settlement,
    facility,
    seller: sellerAddress,
    curator: curatorAddress,
    redemptionOperator: operatorAddress,
    stockAmount: STOCK_AMOUNT.toString(),
    facilityCostUsdc: FACILITY_COST.toString(),
    redemptionProceedsUsdc: REDEMPTION_PROCEEDS.toString(),
    realizedPnlUsdc: (REDEMPTION_PROCEEDS - FACILITY_COST).toString(),
    requestId: requestId ?? null,
    redemptionLotId: lotId.toString(),
    setupTransactions: setup,
    purchaseReceipt: await receiptRecord(client, routeReceipt),
    sellerBalancesBeforePurchase: stringify(sellerBeforePurchase),
    sellerBalancesAfterPurchase: stringify(sellerAfterPurchase),
    operatorApprovalTransaction: operatorApprovalHash ?? null,
    redemptionReceipt: await receiptRecord(client, settleReceipt),
    balancesBeforeSettlement: stringify(balancesBeforeSettlement),
    balancesAfter: stringify(after),
    verified: true,
    checkedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(proofPath), { recursive: true });
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  console.log(`qa-base-redemption=PASS chainId=${BASE_SEPOLIA_CHAIN_ID} candidateSha256=${candidate.candidateSha256} stockDecimals=8 stockAmount=${STOCK_AMOUNT} purchaseTx=${routeHash} redemptionTx=${settleHash} realizedPnlUsdc=${proof.realizedPnlUsdc} proof=${path.relative(rootDir, proofPath)}`);
}

async function send(wallet, client, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account });
  await waitSuccess(client, hash, `BASE_QA_${functionName}`);
  return hash;
}

async function waitSuccess(client, hash, label) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label}_REVERTED`);
  return receipt;
}

async function balance(client, token, owner) {
  return client.readContract({ address: token, abi: USDC_ABI, functionName: 'balanceOf', args: [owner] });
}

async function balanceAt(client, token, owner, blockNumber) {
  return client.readContract({ address: token, abi: USDC_ABI, functionName: 'balanceOf', args: [owner], blockNumber });
}

async function receiptRecord(client, receipt) {
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!block.hash || block.hash !== receipt.blockHash) throw new Error('BASE_QA_RECEIPT_BLOCK_HASH');
  return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: block.hash, status: receipt.status };
}

function stringify(value) {
  return Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, typeof amount === 'bigint' ? amount.toString() : amount]));
}

function stableReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/[\r\n]/u, 1)[0].replaceAll(/https?:\/\/\S+/gu, '[url]');
}
