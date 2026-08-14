import { FdcVerifierClient } from '../packages/flare-sdk/src/data.ts';
import { loadWorktreeEnv } from './load-worktree-env.mjs';

loadWorktreeEnv();

const verifierUrl = process.env.FLARE_FDC_VERIFIER_URL?.trim() || 'https://fdc-verifiers-testnet.flare.network';
const apiKey = process.env.FLARE_FDC_API_KEY?.trim();
if (!apiKey) {
  console.error('fdc-verifier=BLOCKED FLARE_FDC_API_KEY is required; public URL reachability is not credentialed proof');
  process.exitCode = 2;
} else {
const requestBody = {
  url: 'https://swapi.info/api/people/3',
  httpMethod: 'GET',
  headers: '{}',
  queryParams: '{}',
  body: '{}',
  postProcessJq: '{name: .name, height: .height, mass: .mass, numberOfFilms: .films | length, uid: (.url | split("/") | .[-1] | tonumber)}',
  abiSignature: JSON.stringify({
    components: [
      { internalType: 'string', name: 'name', type: 'string' },
      { internalType: 'string', name: 'height', type: 'string' },
      { internalType: 'string', name: 'mass', type: 'string' },
      { internalType: 'uint256', name: 'numberOfFilms', type: 'uint256' },
      { internalType: 'uint256', name: 'uid', type: 'uint256' },
    ],
    name: 'task',
    type: 'tuple',
  }),
};

const verifier = new FdcVerifierClient({ baseUrl: verifierUrl, apiKey });
const prepared = await verifier.prepareRequest('Web2Json', { sourceId: 'PublicWeb2', requestBody });
console.log(`fdc-verifier=PASS attestation=Web2Json source=PublicWeb2 requestBytes=${prepared.abiEncodedRequest.length}`);
}
