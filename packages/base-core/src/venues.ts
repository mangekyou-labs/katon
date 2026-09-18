import type { BaseNetwork } from './network';

export interface VenuePin {
  readonly name: string;
  readonly address: `0x${string}`;
  readonly chainId: number;
  readonly bytecodeHash: `0x${string}`;
  readonly sourceUrl: string;
  readonly pinnedAt: string;
}

export interface VenueManifest {
  readonly network: BaseNetwork;
  readonly chainId: 8453 | 84532;
  readonly pins: readonly VenuePin[];
}

export interface FirstWaveMarket {
  readonly venue: string;
  readonly ticker: string;
}

export const firstWaveMarkets: readonly FirstWaveMarket[] = [];

const MAINNET_PINS = [
  { name: 'aavePool', address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', chainId: 8453, bytecodeHash: '0xffcb26fbebbe09d9b0d8baef76a1fa218989be6c279b7acf9865d8fb6e0718ce', sourceUrl: 'https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol', pinnedAt: '2026-09-09' },
  { name: 'aavePoolAddressesProvider', address: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D', chainId: 8453, bytecodeHash: '0xefb34c67e8737046b820be55b2ee18d57d78eca48058175a3dde822d69b4fa69', sourceUrl: 'https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol', pinnedAt: '2026-09-09' },
  { name: 'aaveUsdcAToken', address: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB', chainId: 8453, bytecodeHash: '0x59d2fd2a4bad76f979bc2c1da50504e072f4b3bb64f5429302a384ad9c0706f2', sourceUrl: 'https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol', pinnedAt: '2026-09-09' },
  { name: 'morphoBlue', address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', chainId: 8453, bytecodeHash: '0xaa76348c0b91e5dfcece228ef6847b0c5081656d2def05c5617bcab659f0b819', sourceUrl: 'https://docs.morpho.org/get-started/resources/addresses/', pinnedAt: '2026-09-09' },
  { name: 'morphoAdaptiveCurveIrm', address: '0x46415998764C29aB2a25CbeA6254146D50D22687', chainId: 8453, bytecodeHash: '0x9978b522abfe0f3b8279800375d833b9d9660ae4f6321a2efb1f1f98850a0cbe', sourceUrl: 'https://docs.morpho.org/get-started/resources/addresses/', pinnedAt: '2026-09-09' },
  { name: 'morphoChainlinkOracleV2Factory', address: '0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d', chainId: 8453, bytecodeHash: '0x4d1158c0b48e5f2f22f20aafed669eb4baa5fbfa6152d530be584900e69e1dc7', sourceUrl: 'https://docs.morpho.org/get-started/resources/addresses/', pinnedAt: '2026-09-09' },
  { name: 'eulerEvc', address: '0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989', chainId: 8453, bytecodeHash: '0xe8b9512aa6d72c962cf217bbaae14b79c8aca550694aab39740786a7c092a209', sourceUrl: 'https://github.com/euler-xyz/euler-interfaces/blob/master/EulerChains.json', pinnedAt: '2026-09-09' },
  { name: 'eulerEvaultFactory', address: '0x7F321498A801A191a93C840750ed637149dDf8D0', chainId: 8453, bytecodeHash: '0xb704ec88e9e85d56e174489031f21abaf401df5d156b374bd6ce6a76e4ba3277', sourceUrl: 'https://github.com/euler-xyz/euler-interfaces/blob/master/EulerChains.json', pinnedAt: '2026-09-09' },
  { name: 'eulerEvaultImplementation', address: '0x30a9A9654804F1e5b3291a86E83EdeD7cF281618', chainId: 8453, bytecodeHash: '0x12e23fbec62747fb792706c24a7444a049f86fdf333cbd1bf5f3cb839ca1eb3c', sourceUrl: 'https://github.com/euler-xyz/euler-interfaces/blob/master/EulerChains.json', pinnedAt: '2026-09-09' },
  { name: 'aerodromeRouter', address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', chainId: 8453, bytecodeHash: '0x8efb4345abb93beb898eb5674f03118003594d744fcb9eb0f261cf942b609146', sourceUrl: 'https://github.com/aerodrome-finance/contracts/blob/main/README.md', pinnedAt: '2026-09-09' },
  { name: 'aerodromePoolFactory', address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', chainId: 8453, bytecodeHash: '0xe2a176e5d2bcfb214b784ec6d6733708a6376a464f203cc265c284c9f349fea3', sourceUrl: 'https://github.com/aerodrome-finance/contracts/blob/main/README.md', pinnedAt: '2026-09-09' },
] as const satisfies readonly VenuePin[];

const SEPOLIA_PINS = [
  { name: 'aavePool', address: '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27', chainId: 84532, bytecodeHash: '0xc97b7e16966b0eafd8bc9eebf8937ee34f1bf0f3d3907d978dedc6148811b0f5', sourceUrl: 'https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol', pinnedAt: '2026-09-09' },
  { name: 'aavePoolAddressesProvider', address: '0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00', chainId: 84532, bytecodeHash: '0xdabec01ff02f2b5983c5095b31963c19e108624289f9614e0aaf33bbbcbbf0f6', sourceUrl: 'https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol', pinnedAt: '2026-09-09' },
  { name: 'morphoBlue', address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', chainId: 84532, bytecodeHash: '0xde5df0406e830f48506c94032a90a393b444b3de1cd5340d8c1a131a41189d3d', sourceUrl: 'https://docs.morpho.org/get-started/resources/addresses/', pinnedAt: '2026-09-09' },
  { name: 'morphoAdaptiveCurveIrm', address: '0x46415998764C29aB2a25CbeA6254146D50D22687', chainId: 84532, bytecodeHash: '0x9978b522abfe0f3b8279800375d833b9d9660ae4f6321a2efb1f1f98850a0cbe', sourceUrl: 'https://docs.morpho.org/get-started/resources/addresses/', pinnedAt: '2026-09-09' },
  { name: 'morphoChainlinkOracleV2Factory', address: '0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d', chainId: 84532, bytecodeHash: '0x4d1158c0b48e5f2f22f20aafed669eb4baa5fbfa6152d530be584900e69e1dc7', sourceUrl: 'https://docs.morpho.org/get-started/resources/addresses/', pinnedAt: '2026-09-09' },
] as const satisfies readonly VenuePin[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidManifest(): never {
  throw new Error('INVALID_VENUE_MANIFEST');
}

function isAddressString(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && (value === '' || /^0x[0-9a-fA-F]{40}$/.test(value));
}

function isBytecodeHashString(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && (value === '' || /^0x[0-9a-fA-F]{64}$/.test(value));
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value;
}

export function parseVenueManifest(input: unknown): VenueManifest {
  if (!isRecord(input)) return invalidManifest();
  const network = input.network;
  const chainId = input.chainId;
  const expectedChainId = network === 'mainnet' ? 8453 : network === 'sepolia' ? 84532 : undefined;
  if ((network !== 'mainnet' && network !== 'sepolia') || chainId !== expectedChainId || !Array.isArray(input.pins)) {
    return invalidManifest();
  }
  const typedNetwork = network as BaseNetwork;
  const typedChainId = chainId as 8453 | 84532;
  const pins = input.pins.map((value) => {
    if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0 || !isAddressString(value.address) || !isBytecodeHashString(value.bytecodeHash) || value.chainId !== typedChainId || typeof value.sourceUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(value.sourceUrl) || !isIsoDate(value.pinnedAt)) {
      return invalidManifest();
    }
    return { name: value.name, address: value.address, chainId: typedChainId, bytecodeHash: value.bytecodeHash, sourceUrl: value.sourceUrl, pinnedAt: value.pinnedAt } satisfies VenuePin;
  });
  return { network: typedNetwork, chainId: typedChainId, pins };
}

function isZeroAddress(address: string): boolean {
  return address === '' || /^0x0{40}$/i.test(address);
}

function isZeroHash(hash: string): boolean {
  return hash === '' || /^0x0{64}$/i.test(hash);
}

export function assertMainnetVenuePinsComplete(manifest: VenueManifest): void {
  if (manifest.network !== 'mainnet' || manifest.chainId !== 8453) throw new Error('MAINNET_MANIFEST_REQUIRED');
  for (const name of MAINNET_PINS.map(({ name: pinName }) => pinName)) {
    const pin = manifest.pins.find((candidate) => candidate.name === name);
    if (!pin) throw new Error(`MISSING_MAINNET_PIN:${name}`);
    if (isZeroAddress(pin.address)) throw new Error('EMPTY_MAINNET_ADDRESS');
    if (isZeroHash(pin.bytecodeHash)) throw new Error('EMPTY_MAINNET_BYTECODE_HASH');
  }
}

export function getVenuePins(network: BaseNetwork): readonly VenuePin[] {
  return network === 'mainnet' ? MAINNET_PINS : SEPOLIA_PINS;
}
