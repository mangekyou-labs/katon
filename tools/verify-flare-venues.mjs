import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, getAddress, http, isAddress, keccak256 } from 'viem';
import { validateVenueVerificationManifest } from './release-evidence.mjs';
import { loadWorktreeEnv } from './load-worktree-env.mjs';

loadWorktreeEnv();

const root = resolve(import.meta.dirname, '..');
const manifestPath = process.env.FLARE_VENUE_MANIFEST;
if (!manifestPath || !existsSync(manifestPath)) throw new Error('VENUE_MANIFEST_REQUIRED');
const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
if (!Number.isInteger(manifest.chainId) || !Array.isArray(manifest.venues) || manifest.venues.length === 0) {
  throw new Error('VENUE_MANIFEST_INVALID');
}
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const client = createPublicClient({ transport: http(rpcUrl) });
const chainId = await client.getChainId();
if (chainId !== manifest.chainId) throw new Error(`VENUE_RPC_CHAIN_ID: expected ${manifest.chainId}, received ${chainId}`);

const verified = [];
for (const venue of manifest.venues) {
  if (!venue || typeof venue.venue !== 'string' || !isAddress(venue.address) || getAddress(venue.address) === '0x0000000000000000000000000000000000000000') {
    throw new Error('VENUE_ENTRY_ADDRESS_INVALID');
  }
  if (!Array.isArray(venue.supportedAssets) || venue.supportedAssets.length === 0 || typeof venue.verifiedReference !== 'string' || !venue.verifiedReference.trim()) {
    throw new Error(`VENUE_ENTRY_METADATA_INVALID:${venue.venue}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(venue.bytecodeHash ?? '')) throw new Error(`VENUE_BYTECODE_HASH_REQUIRED:${venue.venue}`);
  const bytecode = await client.getBytecode({ address: getAddress(venue.address) });
  if (!bytecode || bytecode === '0x') throw new Error(`VENUE_NO_CODE:${venue.venue}`);
  const actualHash = keccak256(bytecode);
  if (actualHash.toLowerCase() !== venue.bytecodeHash.toLowerCase()) throw new Error(`VENUE_BYTECODE_MISMATCH:${venue.venue}`);
  if (venue.market !== undefined) {
    if (!isAddress(venue.market) || getAddress(venue.market) === '0x0000000000000000000000000000000000000000') throw new Error(`VENUE_MARKET_INVALID:${venue.venue}`);
    if (venue.marketBytecodeHash !== undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(venue.marketBytecodeHash)) throw new Error(`VENUE_MARKET_HASH_INVALID:${venue.venue}`);
      const marketCode = await client.getBytecode({ address: getAddress(venue.market) });
      if (!marketCode || marketCode === '0x' || keccak256(marketCode).toLowerCase() !== venue.marketBytecodeHash.toLowerCase()) throw new Error(`VENUE_MARKET_BYTECODE_MISMATCH:${venue.venue}`);
    }
  }
  verified.push({ ...venue, address: getAddress(venue.address), verifiedAtChainId: chainId });
}

const output = { ...manifest, verifiedAt: new Date().toISOString(), verificationMethod: 'rpc-bytecode-keccak256', venues: verified };
const validationErrors = validateVenueVerificationManifest(output, chainId);
if (validationErrors.length > 0) throw new Error(validationErrors.join(','));
if (process.env.FLARE_VENUE_MANIFEST_OUTPUT) writeFileSync(resolve(process.env.FLARE_VENUE_MANIFEST_OUTPUT), `${JSON.stringify(output, null, 2)}\n`);
console.log(`venue-verification=PASS venues=${verified.length} chainId=${chainId}`);
