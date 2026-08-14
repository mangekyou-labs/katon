const ZERO20 = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

function padAddress(value) {
  const hex = value.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  return `0x${hex}`;
}

function padBytes32(value) {
  const hex = value.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return `0x${hex}`;
}

export function buildSimRelayEnvelopes({
  wallet = `${ZERO20.slice(0, -2)}aa`,
  router = `${ZERO20.slice(0, -2)}aa`,
  sellToken = `${ZERO20.slice(0, -2)}10`,
  buyToken = `${ZERO20.slice(0, -2)}20`,
  sellAmount = '100',
  minOutput = '90',
  quotedOutput = '100',
  now = Math.floor(Date.now() / 1_000),
} = {}) {
  const commitment = padBytes32('11');
  const seller = padAddress(wallet);
  const routePlan = {
    chainId: '114',
    router: padAddress(router),
    commitment,
    fccActionId: padBytes32('22'),
    decisionBlock: '1',
    decisionBlockHash: padBytes32('33'),
    deadline: String(now + 86_400),
    seller,
    recipient: seller,
    sellToken: padAddress(sellToken),
    buyToken: padAddress(buyToken),
    sellAmount,
    minOutput,
    protocolFeeBps: 50,
    eligibilityPolicyId: padBytes32('44'),
    eligibilityRevocationEpoch: '0',
    eligibilityRole: '1',
    eligibilityIssuerReference: padBytes32('55'),
    legs: [{
      source: padAddress(wallet),
      sellAmount,
      minOutput,
      sourceData: '0x010203',
    }],
  };
  const auctionCiphertext = JSON.stringify({
    auction: {
      commitment,
      chainId: 114,
      router: routePlan.router,
      sellToken: routePlan.sellToken,
      buyToken: routePlan.buyToken,
      sellAmount,
      minOutput,
      decisionDeadline: now + 3_600,
    },
    routePlan,
  });
  const bidCiphertext = JSON.stringify({
    commitment: padBytes32('aa'),
    bidder: wallet,
    sellToken: routePlan.sellToken,
    buyToken: routePlan.buyToken,
    sellAmount,
    quotedOutput,
    sequence: '1',
    expiresAt: now + 7_200,
  });
  const expiresAt = now + 86_400;
  return {
    commitment,
    auctionEnvelope: {
      version: 1,
      keyId: 'sim-key',
      commitment,
      expiresAt,
      nonce: 'sim-auction-nonce',
      ciphertext: auctionCiphertext,
    },
    bidEnvelope: {
      version: 1,
      keyId: 'sim-key',
      commitment,
      expiresAt,
      nonce: 'sim-bid-nonce',
      ciphertext: bidCiphertext,
    },
  };
}

void ZERO32;
