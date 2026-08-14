import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, stringToHex, zeroAddress, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const manifestPath = process.env.FLARE_DEPLOYMENT_MANIFEST
  ? resolve(root, process.env.FLARE_DEPLOYMENT_MANIFEST)
  : existsSync(resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json'))
    ? resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json')
    : resolve(root, 'contracts/flare/deployments/coston2.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function envKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  const match = readFileSync(resolve(root, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m);
  if (!match) throw new Error('PRIVATE_KEY_REQUIRED');
  return match[1].trim();
}

const extensionRegistry = process.env.FLARE_TEE_EXTENSION_REGISTRY?.trim();
const machineRegistry = process.env.FLARE_TEE_MACHINE_REGISTRY?.trim();
const extensionId = process.env.FLARE_FCC_EXTENSION_ID?.trim();
const quorum = process.env.FLARE_FCC_QUORUM?.trim() ?? '2';
if (!extensionRegistry || !machineRegistry || !extensionId) {
  console.error('fcc-config=BLOCKED missing FLARE_TEE_EXTENSION_REGISTRY, FLARE_TEE_MACHINE_REGISTRY, or FLARE_FCC_EXTENSION_ID');
  process.exitCode = 2;
} else {
  const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
  const account = privateKeyToAccount(envKey());
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const abi = [
    {
      type: 'function', name: 'owner', stateMutability: 'view', inputs: [],
      outputs: [{ type: 'address' }],
    },
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
    {
      type: 'function', name: 'fccQuorumThreshold', stateMutability: 'view', inputs: [],
      outputs: [{ type: 'uint64' }],
    },
    {
      type: 'function', name: 'configureFcc', stateMutability: 'nonpayable',
      inputs: [
        { name: 'extensionRegistry', type: 'address' },
        { name: 'machineRegistry', type: 'address' },
        { name: 'extensionId', type: 'uint256' },
        { name: 'quorumThreshold', type: 'uint64' },
      ], outputs: [],
    },
    {
      type: 'function', name: 'hashOperation', stateMutability: 'pure',
      inputs: [
        { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' }, { name: 'predecessor', type: 'bytes32' }, { name: 'salt', type: 'bytes32' },
      ], outputs: [{ type: 'bytes32' }],
    },
    {
      type: 'function', name: 'schedule', stateMutability: 'nonpayable',
      inputs: [
        { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' }, { name: 'predecessor', type: 'bytes32' }, { name: 'salt', type: 'bytes32' },
      ], outputs: [{ type: 'bytes32' }],
    },
  ];
  const sender = manifest.contracts.instructionSender;
  const current = await Promise.all([
    publicClient.readContract({ address: sender, abi, functionName: 'owner' }),
    publicClient.readContract({ address: sender, abi, functionName: 'fccExtensionRegistry' }),
    publicClient.readContract({ address: sender, abi, functionName: 'fccMachineRegistry' }),
    publicClient.readContract({ address: sender, abi, functionName: 'fccExtensionId' }),
    publicClient.readContract({ address: sender, abi, functionName: 'fccQuorumThreshold' }),
  ]);
  const target = sender;
  const timelock = manifest.configuration.timelock;
  const ownerIsCaller = current[0].toLowerCase() === account.address.toLowerCase();
  const ownerIsTimelock = timelock && current[0].toLowerCase() === timelock.toLowerCase();
  if (!ownerIsCaller && !ownerIsTimelock) throw new Error('FCC_CONFIG_OWNER');
  const requested = [extensionRegistry, machineRegistry, BigInt(extensionId), BigInt(quorum)];
  const alreadyConfigured = current[1].toLowerCase() !== zeroAddress
    && current[1].toLowerCase() === extensionRegistry.toLowerCase()
    && current[2].toLowerCase() === machineRegistry.toLowerCase()
    && current[3] === requested[2]
    && current[4] === requested[3];
  if (alreadyConfigured) {
    console.log('fcc-config=already-configured');
  } else if (current[1].toLowerCase() !== zeroAddress) {
    throw new Error('FCC_CONFIG_IMMUTABLE_MISMATCH');
  } else {
    const configureData = encodeFunctionData({ abi, functionName: 'configureFcc', args: requested });
    const salt = keccak256(stringToHex(`configure-fcc:${extensionRegistry}:${machineRegistry}:${extensionId}:${quorum}`));
    const hash = ownerIsCaller
      ? await walletClient.writeContract({ address: sender, abi, functionName: 'configureFcc', args: requested, account })
      : await walletClient.writeContract({ address: timelock, abi, functionName: 'schedule', args: [target, 0n, configureData, zeroHash, salt], account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`FCC_CONFIG_REVERTED:${hash}`);
    manifest.configuration = ownerIsCaller
      ? {
        ...manifest.configuration,
        fccExtensionRegistry: extensionRegistry,
        fccMachineRegistry: machineRegistry,
        fccExtensionId: extensionId,
        fccQuorumThreshold: Number(quorum),
      }
      : {
        ...manifest.configuration,
        pendingFccConfiguration: {
          extensionRegistry,
          machineRegistry,
          extensionId,
          quorumThreshold: Number(quorum),
          operationSalt: salt,
          status: 'scheduled-not-executed',
        },
      };
    manifest.configurationTransactions = {
      ...manifest.configurationTransactions,
      configureFcc: hash,
      ...(ownerIsTimelock ? { configureFccGovernance: 'scheduled-not-executed' } : {}),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`configureFcc=${hash}`);
  }
  console.log(`extensionRegistry=${extensionRegistry}`);
  console.log(`machineRegistry=${machineRegistry}`);
  console.log(`extensionId=${extensionId}`);
  console.log(`quorum=${quorum}`);
  console.log('fcc-config=PASS');
}
