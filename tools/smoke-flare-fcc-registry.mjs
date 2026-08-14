import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, zeroAddress } from 'viem';
import { flareTestnet } from 'viem/chains';
import { loadWorktreeEnv } from './load-worktree-env.mjs';

loadWorktreeEnv();

const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const managerAddress = process.env.FLARE_TEE_MANAGER ?? '0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE';
const proxyUrl = process.env.FCC_NORMAL_PROXY_URL ?? 'https://tee-proxy-coston2-1.flare.rocks/info';
const manifestPath = process.env.FLARE_DEPLOYMENT_MANIFEST
  ? resolve(root, process.env.FLARE_DEPLOYMENT_MANIFEST)
  : resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json');

const address = (value) => /^0x[0-9a-fA-F]{40}$/.test(value ?? '') && value.toLowerCase() !== zeroAddress;
const managerAbi = [
  {
    type: 'function', name: 'nextPublicExtensionId', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'getTeeExtensionInstructionsSender', stateMutability: 'view',
    inputs: [{ name: 'extensionId', type: 'uint256' }], outputs: [{ type: 'address' }],
  },
];
const senderAbi = [
  {
    type: 'function', name: 'fccExtensionRegistry', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'fccMachineRegistry', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'fccExtensionId', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint256' }],
  },
];

if (!address(managerAddress)) throw new Error('FCC_MANAGER_ADDRESS_INVALID');
if (!existsSync(manifestPath)) throw new Error(`FCC_MANIFEST_NOT_FOUND:${manifestPath}`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sender = manifest.contracts?.instructionSender;
if (!address(sender)) throw new Error('FCC_INSTRUCTION_SENDER_INVALID');
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const client = createPublicClient({ chain, transport: http(rpcUrl) });

const [managerCode, senderCode, nextPublicExtensionId, configured] = await Promise.all([
  client.getBytecode({ address: managerAddress }),
  client.getBytecode({ address: sender }),
  client.readContract({ address: managerAddress, abi: managerAbi, functionName: 'nextPublicExtensionId' }),
  Promise.all([
    client.readContract({ address: sender, abi: senderAbi, functionName: 'fccExtensionRegistry' }),
    client.readContract({ address: sender, abi: senderAbi, functionName: 'fccMachineRegistry' }),
    client.readContract({ address: sender, abi: senderAbi, functionName: 'fccExtensionId' }),
  ]),
]);

if (!managerCode || managerCode === '0x') throw new Error('FCC_MANAGER_NO_CODE');
if (!senderCode || senderCode === '0x') throw new Error('FCC_INSTRUCTION_SENDER_NO_CODE');

let proxyInfo;
try {
  const response = await fetch(proxyUrl);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  proxyInfo = await response.json();
} catch (error) {
  throw new Error(`FCC_NORMAL_PROXY_INFO_FAILED:${error instanceof Error ? error.message : String(error)}`);
}

const proxyExtensionId = proxyInfo?.machineData?.extensionId ?? proxyInfo?.teeInfo?.extensionId;
const normalProxyIsShared = typeof proxyExtensionId === 'string'
  ? /^0x0+$/i.test(proxyExtensionId) || proxyExtensionId === '0'
  : proxyExtensionId === 0 || proxyExtensionId === 0n;
const candidateConfigured = configured[0].toLowerCase() !== zeroAddress
  && configured[1].toLowerCase() !== zeroAddress;

console.log(`fcc-registry=PASS manager=${managerAddress} managerNextPublicExtensionId=${nextPublicExtensionId}`);
console.log(`fcc-normal-proxy=PASS extensionId=${proxyExtensionId ?? 'unknown'} sharedExtension=${normalProxyIsShared}`);
console.log(`fcc-candidate=${candidateConfigured ? 'configured' : 'unconfigured'} instructionSender=${sender} extensionRegistry=${configured[0]} machineRegistry=${configured[1]} extensionId=${configured[2]}`);
if (normalProxyIsShared) console.log('fcc-boundary=DEDICATED_EXTENSION_REQUIRED');
