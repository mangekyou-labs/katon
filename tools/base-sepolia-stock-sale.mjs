import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  http,
  parseEventLogs,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NATIVE_USDC,
} from './base-deployment-lib.mjs';
import {
  assertNonstandardQaWallet,
  deriveBaseQaAccounts,
  parseEnvContents,
  targetQaConfig,
} from './base-qa-lib.mjs';
import {
  candidatePaths,
  parseReleasePathArg,
  readCandidateManifest,
  validateCandidateAccounts,
  validateStockSaleEvidence,
} from './base-release-gate-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN = {
  id: BASE_SEPOLIA_CHAIN_ID,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const STOCK_AMOUNT = 1n * 10n ** 18n;
const USDC_AMOUNT = 1_000_000n;
const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }];
const APPROVAL_EVENT = { type: 'event', name: 'Approval', inputs: [
  { indexed: true, name: 'owner', type: 'address' },
  { indexed: true, name: 'spender', type: 'address' },
  { indexed: false, name: 'value', type: 'uint256' },
] };
const SWAP_FILLED_EVENT = { type: 'event', name: 'SwapFilled', inputs: [
  { indexed: true, name: 'orderHash', type: 'bytes32' },
  { indexed: true, name: 'maker', type: 'address' },
  { indexed: true, name: 'taker', type: 'address' },
  { indexed: false, name: 'stockToken', type: 'address' },
  { indexed: false, name: 'usdcToken', type: 'address' },
  { indexed: false, name: 'stockAmount', type: 'uint256' },
  { indexed: false, name: 'usdcAmount', type: 'uint256' },
] };
const ROUTE_FILLED_EVENT = { type: 'event', name: 'SwapRouteFilled', inputs: [
  { indexed: true, name: 'requestId', type: 'bytes32' },
  { indexed: true, name: 'taker', type: 'address' },
  { indexed: true, name: 'recipient', type: 'address' },
  { indexed: false, name: 'stockToken', type: 'address' },
  { indexed: false, name: 'usdcToken', type: 'address' },
  { indexed: false, name: 'stockAmount', type: 'uint256' },
  { indexed: false, name: 'boughtUsdc', type: 'uint256' },
  { indexed: false, name: 'fee', type: 'uint256' },
] };
const SWAP_ORDER_TYPES = {
  SwapOrder: [
    { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'stockToken', type: 'address' }, { name: 'usdcToken', type: 'address' },
    { name: 'stockAmount', type: 'uint256' }, { name: 'usdcAmount', type: 'uint256' },
    { name: 'fillMode', type: 'uint8' }, { name: 'expiry', type: 'uint256' },
    { name: 'salt', type: 'uint256' }, { name: 'feeCapBps', type: 'uint16' },
    { name: 'allowedTaker', type: 'address' }, { name: 'rfqId', type: 'bytes32' },
  ],
};

try {
  await main();
} catch (error) {
  console.error(`qa-base-swap=FAIL reason=${stableReason(error)}`);
  process.exitCode = 1;
}

async function main() {
  const environment = await readEnvironment();
  const mnemonic = environment.BASE_QA_MNEMONIC?.trim().replace(/\s+/gu, ' ');
  if (!mnemonic) throw new Error('BASE_QA_MNEMONIC');
  const config = targetQaConfig('sepolia', environment);
  const accounts = deriveBaseQaAccounts(mnemonic);
  assertNonstandardQaWallet(accounts);
  const expectedAccounts = Object.fromEntries(accounts.map((entry) => [entry.role, entry.address]));
  const candidate = await readCandidateManifest(rootDir, parseReleasePathArg(process.argv.slice(2), '--candidate'));
  validateCandidateAccounts(candidate.manifest, expectedAccounts);
  const seller = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  const maker = mnemonicToAccount(mnemonic, { addressIndex: 2 });
  const operator = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  // Validate the authenticated LP path before spending gas or touching the
  // candidate contracts.  This keeps a missing bot credential a deterministic
  // preflight failure instead of a later RPC/API timeout.
  const bot = botCredential(environment, maker.address);
  const client = createPublicClient({ chain: CHAIN, transport: http(config.rpcUrl, { timeout: 30_000, retryCount: 1 }) });
  const sellerWallet = createWalletClient({ account: seller, chain: CHAIN, transport: http(config.rpcUrl) });
  const makerWallet = createWalletClient({ account: maker, chain: CHAIN, transport: http(config.rpcUrl) });
  const operatorWallet = createWalletClient({ account: operator, chain: CHAIN, transport: http(config.rpcUrl) });
  const stockToken = getAddress(candidate.manifest.addresses.mockB20);
  const usdcToken = getAddress(candidate.manifest.nativeUsdc || BASE_SEPOLIA_NATIVE_USDC);
  const router = getAddress(candidate.manifest.addresses.router);
  const settlement = getAddress(candidate.manifest.addresses.settlement);

  // Seed the QA-controlled B20 and make the maker's USDC capacity explicit.
  const mintHash = await sellerWallet.writeContract({ address: stockToken, abi: MINT_ABI, functionName: 'mint', args: [seller.address, STOCK_AMOUNT] });
  const mintReceipt = await client.waitForTransactionReceipt({ hash: mintHash });
  assertSuccess(mintReceipt, 'BASE_QA_SWAP_MINT');
  const makerUsdc = await tokenBalance(client, usdcToken, maker.address);
  if (makerUsdc < USDC_AMOUNT) {
    const operatorUsdc = await tokenBalance(client, usdcToken, operator.address);
    if (operatorUsdc < USDC_AMOUNT - makerUsdc) throw new Error('BASE_QA_SWAP_MAKER_USDC_FUNDING');
    const fundHash = await operatorWallet.writeContract({ address: usdcToken, abi: ERC20_ABI, functionName: 'transfer', args: [maker.address, USDC_AMOUNT - makerUsdc] });
    const fundReceipt = await client.waitForTransactionReceipt({ hash: fundHash });
    assertSuccess(fundReceipt, 'BASE_QA_SWAP_USDC_FUNDING');
  }
  const makerApprovalHash = await makerWallet.writeContract({ address: usdcToken, abi: ERC20_ABI, functionName: 'approve', args: [settlement, USDC_AMOUNT] });
  const makerApprovalReceipt = await client.waitForTransactionReceipt({ hash: makerApprovalHash });
  assertSuccess(makerApprovalReceipt, 'BASE_QA_SWAP_MAKER_APPROVAL');

  const now = BigInt(Math.floor(Date.now() / 1000));
  const order = {
    maker: getAddress(maker.address),
    signer: getAddress(maker.address),
    stockToken,
    usdcToken,
    stockAmount: STOCK_AMOUNT,
    usdcAmount: USDC_AMOUNT,
    fillMode: 0,
    expiry: now + 600n,
    salt: BigInt(Date.now()),
    feeCapBps: 0,
    // The quote service creates the request id only after the order is
    // registered, so this canary uses a reusable standing order. Standing
    // orders must leave allowedTaker unset (zero); fillMode=0 still requires
    // the full signed capacity.
    allowedTaker: ZERO_ADDRESS,
    rfqId: ZERO_HASH,
  };
  const domain = { name: 'KatonRFQSettlement', version: '2', chainId: BASE_SEPOLIA_CHAIN_ID, verifyingContract: settlement };
  const signature = await maker.signTypedData({ domain, types: SWAP_ORDER_TYPES, primaryType: 'SwapOrder', message: order });
  const orderHash = hashTypedData({ domain, types: SWAP_ORDER_TYPES, primaryType: 'SwapOrder', message: order });

  const apiUrl = config.apiUrl.replace(/\/$/u, '');
  const registration = await apiJson(`${apiUrl}/v1/swap-orders`, {
    method: 'POST',
    headers: { ...botHeaders(bot, 'POST', '/v1/swap-orders', JSON.stringify({
      action: 'register',
      order: stringifyOrder(order),
      signature,
      remainingCapacity: STOCK_AMOUNT.toString(10),
    })) },
    body: JSON.stringify({ action: 'register', order: stringifyOrder(order), signature, remainingCapacity: STOCK_AMOUNT.toString(10) }),
  });
  if (registration.orderHash?.toLowerCase() !== orderHash.toLowerCase()) throw new Error('BASE_QA_SWAP_ORDER_HASH');

  // Seller approval is deliberately settled before the quote call. The API's
  // preflight reads this exact allowance at its simulation block.
  const sellerApprovalHash = await sellerWallet.writeContract({ address: stockToken, abi: ERC20_ABI, functionName: 'approve', args: [settlement, STOCK_AMOUNT] });
  const sellerApprovalReceipt = await client.waitForTransactionReceipt({ hash: sellerApprovalHash });
  assertSuccess(sellerApprovalReceipt, 'BASE_QA_SWAP_SELLER_APPROVAL');
  // The proof binds the approval to a block no later than the API decision
  // block (latest - 1). Wait for one subsequent block so a same-block quote
  // cannot produce an otherwise valid route with unverifiable block order.
  await waitForBlockAfter(client, sellerApprovalReceipt.blockNumber);

  const sessionToken = await establishSiwe(apiUrl, seller);
  const quoteBody = {
    stockToken,
    usdcToken,
    sellAmount: STOCK_AMOUNT.toString(10),
    minBuyAmount: USDC_AMOUNT.toString(10),
    taker: getAddress(seller.address),
    recipient: getAddress(seller.address),
    deadline: (now + 300n).toString(10),
  };
  const quote = await apiJson(`${apiUrl}/v1/swaps/quote`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(quoteBody),
  });
  const route = quote.recommended;
  if (quote.status !== 'WINNER' || !route || route.kind !== 'INTERNAL' || !route.transaction?.to || !route.transaction?.data) {
    throw new Error('BASE_QA_SWAP_ROUTE_REQUIRED');
  }
  if (route.decisionBlock === undefined || !quote.simulationBlock || !quote.simulationBlockHash || !quote.decisionBlockHash) {
    throw new Error('BASE_QA_SWAP_PREFLIGHT_REQUIRED');
  }
  // The API owns the decision snapshot and may be one public-RPC response
  // behind the wallet client. Refuse to spend the settlement transaction if
  // its decision block predates the already-mined seller approval; the proof
  // validator applies the same ordering rule after settlement.
  let decisionBlock;
  try { decisionBlock = BigInt(route.decisionBlock); } catch { throw new Error('BASE_QA_SWAP_PREFLIGHT_BLOCK_ORDER'); }
  if (decisionBlock < sellerApprovalReceipt.blockNumber) throw new Error('BASE_QA_SWAP_PREFLIGHT_BLOCK_ORDER');

  const routeHash = await sellerWallet.sendTransaction({
    account: seller,
    to: route.transaction.to,
    data: route.transaction.data,
    value: BigInt(route.transaction.value ?? '0'),
  });
  const settlementReceipt = await client.waitForTransactionReceipt({ hash: routeHash });
  assertSuccess(settlementReceipt, 'BASE_QA_SWAP_SETTLEMENT');
  // Pin both sides of the conservation proof to mined blocks. Public Base
  // Sepolia RPCs are load-balanced and a latest read can briefly observe a
  // node that has not indexed the just-mined settlement receipt yet.
  const balancesBefore = await readBalances(
    client,
    [seller.address, maker.address, router, settlement],
    stockToken,
    usdcToken,
    settlementReceipt.blockNumber - 1n,
  );
  const balancesAfter = await readBalances(
    client,
    [seller.address, maker.address, router, settlement],
    stockToken,
    usdcToken,
    settlementReceipt.blockNumber,
  );
  const remainingAllowance = await client.readContract({
    address: stockToken,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [seller.address, settlement],
    blockNumber: settlementReceipt.blockNumber,
  });
  if (remainingAllowance !== 0n) throw new Error('BASE_QA_SWAP_ALLOWANCE_REMAINS');
  const dust = {
    routerStock: balancesAfter.router.stock,
    routerUsdc: balancesAfter.router.usdc,
    settlementStock: balancesAfter.settlement.stock,
    settlementUsdc: balancesAfter.settlement.usdc,
  };
  if (Object.values(dust).some((value) => value !== '0')) throw new Error('BASE_QA_SWAP_DUST');

  const approvalEvent = await decodeApproval(
    sellerApprovalReceipt.logs,
    client,
    sellerApprovalReceipt,
    stockToken,
    seller.address,
    settlement,
    STOCK_AMOUNT,
  );
  const swapEvent = decodeSwapFilled(settlementReceipt.logs, settlement);
  const routeEvent = decodeRouteFilled(settlementReceipt.logs, router);
  const proof = {
    schemaVersion: 1,
    kind: 'base-sepolia-stock-sale',
    target: 'sepolia',
    chainId: BASE_SEPOLIA_CHAIN_ID,
    candidateSha256: candidate.candidateSha256,
    stockToken,
    nativeUsdc: usdcToken,
    router,
    settlement,
    seller: getAddress(seller.address),
    maker: getAddress(maker.address),
    requestId: quote.requestId,
    routeId: route.routeId,
    orderHash,
    stockAmount: STOCK_AMOUNT.toString(10),
    usdcAmount: USDC_AMOUNT.toString(10),
    approval: approvalEvent,
    settlementEvent: swapEvent,
    routeEvent,
    approvalReceipt: receiptRecord(sellerApprovalReceipt),
    settlementReceipt: receiptRecord(settlementReceipt),
    decisionBlock: String(quote.decisionBlock),
    decisionBlockHash: quote.decisionBlockHash,
    simulationBlock: String(quote.simulationBlock),
    simulationBlockHash: quote.simulationBlockHash,
    balancesBefore,
    balancesAfter,
    balanceAddresses: { seller: getAddress(seller.address), maker: getAddress(maker.address) },
    remainingSellerStockAllowance: remainingAllowance.toString(10),
    dust,
    checkedAt: new Date().toISOString(),
  };
  validateStockSaleEvidence(proof, candidate.manifest, candidate.candidateSha256, expectedAccounts);
  const outputPath = candidatePaths(rootDir, 'sepolia').swapProofPath;
  await writeProof(outputPath, proof);
  console.log(`qa-base-swap=PASS chainId=${BASE_SEPOLIA_CHAIN_ID} candidateSha256=${candidate.candidateSha256} orderHash=${orderHash} routeId=${route.routeId} approvalTx=${sellerApprovalHash} settlementTx=${routeHash} proof=${path.relative(rootDir, outputPath)}`);
}

function stringifyOrder(order) {
  return Object.fromEntries(Object.entries(order).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString(10) : value]));
}

async function establishSiwe(apiUrl, account) {
  const nonce = await apiJson(`${apiUrl}/v1/auth/nonce`);
  const origin = new URL(apiUrl).origin;
  const message = `${nonce.domain} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Katon Base.\n\nURI: ${origin}/\nVersion: 1\nChain ID: ${nonce.chainId}\nNonce: ${nonce.nonce}\nIssued At: ${nonce.issuedAt}\nExpiration Time: ${nonce.expirationTime}`;
  const signature = await account.signMessage({ message });
  const verified = await apiJson(`${apiUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  if (typeof verified.sessionToken !== 'string' || verified.sessionToken.length < 10) throw new Error('BASE_QA_SWAP_SIWE');
  return verified.sessionToken;
}

async function waitForBlockAfter(client, blockNumber) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const latest = await client.getBlock({ blockTag: 'latest' });
      if (latest.number !== undefined && latest.number > blockNumber) return;
    } catch {
      // A public RPC may briefly lag while the next block is indexed.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('BASE_QA_SWAP_APPROVAL_BLOCK_WAIT');
}

function botCredential(environment, makerAddress) {
  const id = environment.BASE_QA_LP_BOT_ID || environment.BASE_QA_BOT_ID || environment.KATON_BASE_LP_BOT_ID;
  const secret = environment.BASE_QA_LP_BOT_SECRET || environment.BASE_QA_BOT_SECRET || environment.KATON_BASE_LP_BOT_SECRET;
  if (!id || !secret) throw new Error('BASE_QA_LP_BOT_CREDENTIALS');
  return { id, secret, makerAddress };
}

function botHeaders(bot, method, requestPath, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = `${method}\n${requestPath}\n${timestamp}\n${bodyHash}`;
  const signature = `0x${createHmac('sha256', bot.secret).update(canonical, 'utf8').digest('hex')}`;
  return {
    authorization: `Bearer katon_bot_${bot.id}.${bot.secret}`,
    'x-katon-timestamp': String(timestamp),
    'x-katon-body-sha256': `0x${bodyHash}`,
    'x-katon-signature': signature,
    'content-type': 'application/json',
  };
}

async function tokenBalance(client, token, account, blockNumber) {
  return client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

async function readBalances(client, accounts, stockToken, usdcToken, blockNumber) {
  const result = {};
  for (const account of accounts) {
    result[account.toLowerCase()] = {
      stock: (await tokenBalance(client, stockToken, account, blockNumber)).toString(10),
      usdc: (await tokenBalance(client, usdcToken, account, blockNumber)).toString(10),
    };
  }
  const byAddress = (address) => result[address.toLowerCase()];
  return {
    seller: byAddress(accounts[0]),
    maker: byAddress(accounts[1]),
    router: byAddress(accounts[2]),
    settlement: byAddress(accounts[3]),
  };
}

async function decodeApproval(logs, client, receipt, token, owner, spender, amount) {
  let parsed;
  try {
    parsed = parseEventLogs({ abi: [APPROVAL_EVENT], logs, eventName: 'Approval' }).find((entry) => (
      entry.address.toLowerCase() === token.toLowerCase()
        && entry.args.owner.toLowerCase() === owner.toLowerCase()
        && entry.args.spender.toLowerCase() === spender.toLowerCase()
    ));
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    return {
      eventName: 'Approval', logAddress: getAddress(parsed.address), transactionHash: parsed.transactionHash,
      blockNumber: String(parsed.blockNumber), logIndex: String(parsed.logIndex),
      owner: getAddress(parsed.args.owner), spender: getAddress(parsed.args.spender), value: parsed.args.value.toString(10),
    };
  }

  // The deployed BaseQaB20 candidate predates the standard ERC-20 Approval
  // event. Preserve truthful evidence by proving the mined approve call and
  // its resulting allowance instead of fabricating an event record.
  let transaction;
  try {
    transaction = await client.getTransaction({ hash: receipt.transactionHash });
  } catch {
    throw new Error('BASE_QA_SWAP_APPROVAL_RECEIPT');
  }
  if (!transaction || !transaction.to || typeof transaction.from !== 'string'
    || transaction.to.toLowerCase() !== token.toLowerCase()
    || transaction.from.toLowerCase() !== owner.toLowerCase()
    || transaction.blockNumber !== receipt.blockNumber
    || typeof transaction.input !== 'string') {
    throw new Error('BASE_QA_SWAP_APPROVAL_CALL');
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ERC20_ABI, data: transaction.input });
  } catch {
    throw new Error('BASE_QA_SWAP_APPROVAL_CALL');
  }
  const [decodedSpender, decodedAmount] = decoded.functionName === 'approve' ? decoded.args : [];
  const allowanceAtReceipt = await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
    blockNumber: receipt.blockNumber,
  });
  if (decoded.functionName !== 'approve'
    || typeof decodedSpender !== 'string'
    || decodedSpender.toLowerCase() !== spender.toLowerCase()
    || decodedAmount !== amount
    || allowanceAtReceipt !== amount) {
    throw new Error('BASE_QA_SWAP_APPROVAL_CALL');
  }
  return {
    eventName: 'ApprovalCall', evidence: 'receipt-input', logAddress: getAddress(token),
    transactionHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber),
    owner: getAddress(owner), spender: getAddress(spender), value: amount.toString(10),
    transactionFrom: getAddress(transaction.from), transactionTo: getAddress(transaction.to),
    functionName: 'approve', callData: transaction.input,
  };
}

function decodeSwapFilled(logs, settlement) {
  const parsed = parseEventLogs({ abi: [SWAP_FILLED_EVENT], logs, eventName: 'SwapFilled' }).find((entry) => entry.address.toLowerCase() === settlement.toLowerCase());
  if (!parsed) throw new Error('BASE_QA_SWAP_SETTLEMENT_EVENT');
  return {
    eventName: 'SwapFilled', logAddress: getAddress(parsed.address), transactionHash: parsed.transactionHash,
    blockNumber: String(parsed.blockNumber), logIndex: String(parsed.logIndex),
    orderHash: parsed.args.orderHash, maker: getAddress(parsed.args.maker), taker: getAddress(parsed.args.taker),
    stockToken: getAddress(parsed.args.stockToken), usdcToken: getAddress(parsed.args.usdcToken),
    stockAmount: parsed.args.stockAmount.toString(10), usdcAmount: parsed.args.usdcAmount.toString(10),
  };
}

function decodeRouteFilled(logs, router) {
  const parsed = parseEventLogs({ abi: [ROUTE_FILLED_EVENT], logs, eventName: 'SwapRouteFilled' }).find((entry) => entry.address.toLowerCase() === router.toLowerCase());
  if (!parsed) throw new Error('BASE_QA_SWAP_ROUTE_EVENT');
  return {
    eventName: 'SwapRouteFilled', logAddress: getAddress(parsed.address), transactionHash: parsed.transactionHash,
    blockNumber: String(parsed.blockNumber), logIndex: String(parsed.logIndex),
    requestId: parsed.args.requestId, taker: getAddress(parsed.args.taker), recipient: getAddress(parsed.args.recipient),
    stockToken: getAddress(parsed.args.stockToken), usdcToken: getAddress(parsed.args.usdcToken),
    stockAmount: parsed.args.stockAmount.toString(10), boughtUsdc: parsed.args.boughtUsdc.toString(10), fee: parsed.args.fee.toString(10),
  };
}

function receiptRecord(receipt) {
  return { transactionHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), status: receipt.status };
}

function assertSuccess(receipt, code) {
  if (receipt.status !== 'success') throw new Error(code);
}

async function apiJson(url, init = {}) {
  let response;
  try { response = await fetch(url, init); } catch { throw new Error('BASE_QA_SWAP_API_UNAVAILABLE'); }
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (!response.ok) {
    const reason = typeof body?.message === 'string'
      ? body.message
      : typeof body?.code === 'string'
        ? body.code
        : `BASE_QA_SWAP_API_${response.status}`;
    throw new Error(reason);
  }
  return body;
}

async function readEnvironment() {
  let fileEnvironment = {};
  try { fileEnvironment = parseEnvContents(await fs.readFile(path.join(rootDir, '.env.base-qa.local'), 'utf8')); } catch (error) {
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
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error(`BASE_QA_SWAP_PROOF_WRITE:${error instanceof Error ? error.message : String(error)}`);
  }
}

function stableReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^[A-Z][A-Z0-9_:-]+$/u.test(message)) return message;
  if (message.startsWith('BASE_QA_')) return message.split(':', 1)[0];
  return 'BASE_QA_SWAP';
}
