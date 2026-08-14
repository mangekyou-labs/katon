import { describe, expect, it } from 'vitest';

import scaffoldContract from '../fixtures/flare/fcc-scaffold-contract.json';
import weatherContract from '../fixtures/flare/fce-weather-api.json';
import { FCC_OPERATIONS } from '../packages/flare-core/src/fccOperations';
import { bytes32Identifier } from '../packages/flare-core/src/fccEnvelope';

describe('FCC scaffold contract pin', () => {
  it('records the reviewed upstream and required extension boundary', () => {
    expect(scaffoldContract.upstream).toBe(
      'https://github.com/flare-foundation/fce-extension-scaffold',
    );
    expect(scaffoldContract.commit).toBeNull();
    expect(scaffoldContract.pinStatus).toBe('conformance-only');
    expect(scaffoldContract.license).toBe('MIT');
    expect(scaffoldContract.simulatedOnly).toBe(true);
    expect(scaffoldContract.http.required).toEqual({
      action: 'POST /action',
      state: 'GET /state',
      proxyInstruction: 'POST /instruction',
      actionStatus: 'GET /action/status/<epoch>/<instructionId>',
      proxyPort: 6664,
    });
    expect(scaffoldContract.crypto.decryptRequestEncoding).toBe('base64');
    expect(scaffoldContract.crypto.originalMessageEncoding).toBe('hex');
  });

  it('uses Weather API as the implementation baseline and keeps the scaffold conformance-only', () => {
    expect(weatherContract.upstream).toBe('https://github.com/flare-foundation/fce-weather-api');
    expect(weatherContract.license).toBe('MIT');
    expect(weatherContract.wire).toMatchObject({ info: 'GET /info', state: 'GET /state', action: 'POST /action', decrypt: 'POST /decrypt' });
    expect(weatherContract.crypto.recipientEncryption).toContain('ECIES');
    expect(scaffoldContract.pinStatus).toBe('conformance-only');
  });

  it('uses FCC right-padded bytes32 operation identifiers', () => {
    expect(FCC_OPERATIONS.RFQ).toBe(bytes32Identifier('RFQ'));
    expect(FCC_OPERATIONS.FINALIZE).toBe(bytes32Identifier('FINALIZE'));
  });
});
