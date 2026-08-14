import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Hex, type PublicClient } from 'viem';

import {
  FdcVerifierClient,
  calculateFdcVotingRound,
  buildUnsignedFdcRequestTransaction,
  buildUnsignedNavProofTransaction,
  decodeFdcWeb2JsonProof,
  hashFdcWeb2JsonRequestBody,
  readFdcRoundFinality,
  waitForFdcRoundFinality,
  readLiveFtsoFeed,
} from '../packages/flare-sdk/src/data';

describe('Flare live data boundaries', () => {
  it('calculates the FDC voting round from the mined block timestamp', () => {
    expect(calculateFdcVotingRound(1_658_430_000n, 1_658_430_000n, 90n)).toBe(0);
    expect(calculateFdcVotingRound(1_658_430_179n, 1_658_430_000n, 90n)).toBe(1);
    expect(() => calculateFdcVotingRound(1_658_429_999n, 1_658_430_000n, 90n)).toThrow('FDC_ROUND_TIMESTAMP');
  });

  it('waits for finality and fails on a timeout without accepting an unfinalized round', async () => {
    let attempts = 0;
    const reader = async () => {
      attempts += 1;
      return { protocolId: 200, finalized: attempts >= 2 };
    };
    await expect(waitForFdcRoundFinality(reader, 7, { intervalMs: 0, maxAttempts: 3 })).resolves.toEqual({ protocolId: 200, finalized: true });
    await expect(waitForFdcRoundFinality(async () => ({ protocolId: 200, finalized: false }), 7, { intervalMs: 0, maxAttempts: 2 })).rejects.toThrow('FDC_FINALITY_TIMEOUT');
  });

  it('resolves FTSOv2 through the runtime registry and preserves signed decimals', async () => {
    const calls: string[] = [];
    const client = {
      getChainId: async () => 114,
      readContract: async ({ functionName, args }: { readonly functionName: string; readonly args?: readonly string[] }) => {
        calls.push(functionName);
        if (functionName === 'getContractAddressByName' && args?.[0] === 'FtsoV2') return '0x00000000000000000000000000000000000000aa';
        return [12345n, -2, 1_700_000_000n] as const;
      },
    } as unknown as PublicClient;
    await expect(readLiveFtsoFeed(client, {
      network: 'coston2',
      registryAddress: '0x00000000000000000000000000000000000000bb',
      feedId: '0x01464c522f55534400000000000000000000000000',
    })).resolves.toEqual({
      feedId: '0x01464c522f55534400000000000000000000000000',
      value: 12345n,
      decimals: -2,
      timestamp: 1_700_000_000,
    });
    expect(calls).toEqual(['getContractAddressByName', 'getFeedById']);
  });

  it('fails closed on wrong chain, malformed feed IDs, and missing registry contracts', async () => {
    const client = {
      getChainId: async () => 14,
      readContract: async () => '0x00000000000000000000000000000000000000aa',
    } as unknown as PublicClient;
    await expect(readLiveFtsoFeed(client, {
      network: 'coston2',
      registryAddress: '0x00000000000000000000000000000000000000bb',
      feedId: '0x01464c522f55534400000000000000000000000000',
    })).rejects.toThrow('FTSO_CHAIN_ID');
    await expect(readLiveFtsoFeed({ ...client, getChainId: async () => 114 } as PublicClient, {
      network: 'coston2',
      registryAddress: '0x00000000000000000000000000000000000000bb',
      feedId: '0x1234',
    })).rejects.toThrow('FTSO_FEED_ID');
  });

  it('prepares verifier requests and retrieves only proof-shaped DA responses', async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      if (String(input).includes('prepareRequest')) {
        return new Response(JSON.stringify({ abiEncodedRequest: '0x1234', requestId: 'id' }), { status: 200 });
      }
      return new Response(JSON.stringify({ proofs: ['0xabcd'], response_hex: '0xdeadbeef' }), { status: 200 });
    };
    const verifier = new FdcVerifierClient({ baseUrl: 'https://verifier.example/', apiKey: 'secret', fetcher });
    await expect(verifier.prepareRequest('EVMTransaction', { sourceId: 'testETH', requestBody: {} })).resolves.toMatchObject({ abiEncodedRequest: '0x1234' });
    await expect(verifier.getProof('https://da.example/', 12, '0x1234')).resolves.toMatchObject({ proofs: ['0xabcd'], responseHex: '0xdeadbeef' });
    expect(requests[0]?.url).toBe('https://verifier.example/verifier/eth/EVMTransaction/prepareRequest');
    expect(requests[0]?.body).toMatchObject({
      attestationType: '0x45564d5472616e73616374696f6e000000000000000000000000000000000000',
      sourceId: '0x7465737445544800000000000000000000000000000000000000000000000000',
    });
    expect(requests[1]?.url).toBe('https://da.example/api/v1/fdc/proof-by-request-round-raw');
    expect(requests[0]?.headers.get('x-api-key')).toBe('secret');
  });

  it('accepts the official DA response proof alias and attestation metadata', async () => {
    const verifier = new FdcVerifierClient({
      baseUrl: 'https://verifier.example/',
      fetcher: async () => new Response(JSON.stringify({
        proof: ['0xabcd'],
        response_hex: '0xdeadbeef',
        attestation_type: '0x576562324a736f6e000000000000000000000000000000000000000000000000',
      }), { status: 200 }),
    });
    await expect(verifier.getProof('https://da.example/', 12, '0x1234')).resolves.toMatchObject({
      proofs: ['0xabcd'],
      responseHex: '0xdeadbeef',
      attestationType: '0x576562324a736f6e000000000000000000000000000000000000000000000000',
    });
  });

  it('rejects Web2Json requests whose ABI signature is not the verifier JSON schema', async () => {
    const verifier = new FdcVerifierClient({
      baseUrl: 'https://verifier.example/',
      fetcher: async () => new Response(JSON.stringify({ abiEncodedRequest: '0x1234' }), { status: 200 }),
    });
    await expect(verifier.prepareRequest('Web2Json', {
      sourceId: 'PublicWeb2',
      requestBody: {
        url: 'https://example.test',
        httpMethod: 'GET',
        headers: '{}',
        queryParams: '{}',
        body: '{}',
        postProcessJq: '.',
        abiSignature: 'tuple(string name)',
      },
    })).rejects.toThrow('FDC_ABI_SIGNATURE');
  });

  it('builds an unsigned FDC request and reads relay finality through the registry', async () => {
    const calls: string[] = [];
    const client = {
      getChainId: async () => 114,
      readContract: async ({ functionName, args }: { readonly functionName: string; readonly args?: readonly string[] }) => {
        calls.push(functionName);
        if (functionName === 'getContractAddressByName' && args?.[0] === 'FdcHub') return '0x00000000000000000000000000000000000000aa';
        if (functionName === 'getContractAddressByName' && args?.[0] === 'FdcVerification') return '0x00000000000000000000000000000000000000bb';
        if (functionName === 'fdcProtocolId') return 200n;
        if (functionName === 'relay') return '0x00000000000000000000000000000000000000cc';
        return true;
      },
    } as unknown as PublicClient;
    const transaction = await buildUnsignedFdcRequestTransaction(client, {
      network: 'coston2',
      registryAddress: '0x00000000000000000000000000000000000000dd',
      requestBytes: '0x1234',
      feeWei: 1n,
    });
    expect(transaction).toMatchObject({
      to: '0x00000000000000000000000000000000000000AA',
      chainId: 114,
      value: 1n,
    });
    expect(transaction.data).toMatch(/^0x/);
    await expect(readFdcRoundFinality(client, {
      network: 'coston2',
      registryAddress: '0x00000000000000000000000000000000000000dd',
      votingRoundId: 123,
    })).resolves.toEqual({ protocolId: 200, finalized: true });
    expect(calls).toEqual(['getContractAddressByName', 'getContractAddressByName', 'fdcProtocolId', 'relay', 'isFinalized']);
  });

  it('decodes a typed Web2Json proof and builds the guarded NAV transaction', () => {
    const responseHex = encodeAbiParameters([
      {
        type: 'tuple', components: [
          { name: 'attestationType', type: 'bytes32' },
          { name: 'sourceId', type: 'bytes32' },
          { name: 'votingRound', type: 'uint64' },
          { name: 'lowestUsedTimestamp', type: 'uint64' },
          {
            name: 'requestBody', type: 'tuple', components: [
              { name: 'url', type: 'string' }, { name: 'httpMethod', type: 'string' },
              { name: 'headers', type: 'string' }, { name: 'queryParams', type: 'string' },
              { name: 'body', type: 'string' }, { name: 'postProcessJq', type: 'string' },
              { name: 'abiSignature', type: 'string' },
            ],
          },
          { name: 'responseBody', type: 'tuple', components: [{ name: 'abiEncodedData', type: 'bytes' }] },
        ],
      },
    ], [{
      attestationType: '0x576562324a736f6e000000000000000000000000000000000000000000000000',
      sourceId: '0x5075626c69635765623200000000000000000000000000000000000000000000',
      votingRound: 7n,
      lowestUsedTimestamp: 1_700_000_000n,
      requestBody: { url: 'https://example.test/nav', httpMethod: 'GET', headers: '{}', queryParams: '{}', body: '{}', postProcessJq: '.', abiSignature: 'tuple(address asset,uint256 value,uint8 decimals,uint64 asOf,uint64 validUntil)' },
      responseBody: { abiEncodedData: encodeAbiParameters([{ type: 'tuple', components: [{ name: 'asset', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'decimals', type: 'uint8' }, { name: 'asOf', type: 'uint64' }, { name: 'validUntil', type: 'uint64' }] }], [{ asset: '0x00000000000000000000000000000000000000aa', value: 123456n, decimals: 2, asOf: 1_700_000_000n, validUntil: 1_700_100_000n }]) },
    }]);
    const proof = decodeFdcWeb2JsonProof([`0x${'11'.repeat(32)}` as Hex], responseHex);
    expect(proof.data.votingRound).toBe(7n);
    expect(proof.data.responseBody.abiEncodedData).toMatch(/^0x/);
    const transaction = buildUnsignedNavProofTransaction(
      114,
      '0x00000000000000000000000000000000000000bb',
      '0x00000000000000000000000000000000000000aa',
      proof,
    );
    expect(transaction).toMatchObject({ chainId: 114, value: 0n, to: '0x00000000000000000000000000000000000000bb' });
    expect(transaction.data).toMatch(/^0x/);
    expect(hashFdcWeb2JsonRequestBody(proof.data.requestBody)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('accepts the empty Merkle proof returned for a single attestation', () => {
    const responseHex = encodeAbiParameters([
      {
        type: 'tuple', components: [
          { name: 'attestationType', type: 'bytes32' }, { name: 'sourceId', type: 'bytes32' },
          { name: 'votingRound', type: 'uint64' }, { name: 'lowestUsedTimestamp', type: 'uint64' },
          { name: 'requestBody', type: 'tuple', components: [
            { name: 'url', type: 'string' }, { name: 'httpMethod', type: 'string' },
            { name: 'headers', type: 'string' }, { name: 'queryParams', type: 'string' },
            { name: 'body', type: 'string' }, { name: 'postProcessJq', type: 'string' },
            { name: 'abiSignature', type: 'string' },
          ] },
          { name: 'responseBody', type: 'tuple', components: [{ name: 'abiEncodedData', type: 'bytes' }] },
        ],
      },
    ], [{
      attestationType: '0x576562324a736f6e000000000000000000000000000000000000000000000000',
      sourceId: '0x5075626c69635765623200000000000000000000000000000000000000000000',
      votingRound: 7n, lowestUsedTimestamp: 1_700_000_000n,
      requestBody: { url: 'https://example.test', httpMethod: 'GET', headers: '{}', queryParams: '{}', body: '{}', postProcessJq: '.', abiSignature: 'tuple(uint256 value)' },
      responseBody: { abiEncodedData: '0x1234' },
    }]);
    const proof = decodeFdcWeb2JsonProof([], responseHex);
    expect(proof.merkleProof).toEqual([]);
    expect(buildUnsignedNavProofTransaction(114, '0x00000000000000000000000000000000000000bb', '0x00000000000000000000000000000000000000aa', proof).data).toMatch(/^0x/);
  });

  it('rejects a proof with the wrong attestation type before wallet signing', () => {
    const responseHex = encodeAbiParameters([
      {
        type: 'tuple', components: [
          { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'uint64' },
          { type: 'tuple', components: [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }] },
          { type: 'tuple', components: [{ type: 'bytes' }] },
        ],
      },
    ], [[
      '0x45564d5472616e73616374696f6e000000000000000000000000000000000000',
      '0x5075626c69635765623200000000000000000000000000000000000000000000', 1n, 1n,
      ['https://example.test', 'GET', '{}', '{}', '{}', '.', 'tuple(uint256)'], ['0x1234'],
    ]]);
    expect(() => decodeFdcWeb2JsonProof([`0x${'11'.repeat(32)}` as Hex], responseHex)).toThrow('FDC_ATTESTATION_TYPE');
  });
});
