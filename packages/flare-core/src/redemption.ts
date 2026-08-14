export interface RedemptionRequest {
  readonly id: number;
  readonly asset: string;
  readonly expectedAssets: bigint;
  readonly inventoryAmount: bigint;
  readonly recipient: string;
  readonly issuerReference: string;
  readonly openedAt: number;
  readonly deadline: number;
}

export interface RedemptionProof {
  readonly requestId: number;
  readonly requestDigest: string;
  readonly asset: string;
  readonly inventoryAmount: bigint;
  readonly expectedAssets: bigint;
  readonly receivedAssets: bigint;
  readonly recipient: string;
  readonly issuerReference: string;
  readonly sourceId: string;
  readonly asOf: number;
  readonly validUntil: number;
  readonly proofOwner: string;
  readonly proofValid: boolean;
}

export interface RedemptionSettlement {
  readonly requestId: number;
  readonly receivedAssets: bigint;
  readonly realizedLoss: bigint;
}

interface StoredRequest extends RedemptionRequest {
  settled: boolean;
}

export class RedemptionProofRegistry {
  private readonly requests = new Map<number, StoredRequest>();
  private readonly usedProofs = new Set<string>();

  open(request: RedemptionRequest): void {
    if (this.requests.has(request.id)) throw new Error('REDEMPTION_EXISTS');
    if (
      request.id <= 0 ||
      !request.asset ||
      request.expectedAssets <= 0n ||
      request.inventoryAmount <= 0n ||
      !request.recipient ||
      !request.issuerReference ||
      request.openedAt < 0 ||
      request.deadline < request.openedAt
    ) {
      throw new Error('REDEMPTION_SCHEMA');
    }
    this.requests.set(request.id, { ...request, settled: false });
  }

  accept(proof: RedemptionProof, caller: string, now: number): RedemptionSettlement {
    const request = this.requests.get(proof.requestId);
    if (!request) throw new Error('REDEMPTION_UNKNOWN');
    if (caller !== proof.proofOwner) throw new Error('PROOF_OWNER');
    if (this.usedProofs.has(proof.requestDigest)) throw new Error('PROOF_REPLAY');
    if (request.settled) throw new Error('REDEMPTION_SETTLED');
    if (!proof.proofValid || !proof.requestDigest) throw new Error('PROOF_INVALID');
    if (!proof.sourceId || proof.validUntil < proof.asOf) throw new Error('PROOF_SCHEMA');
    if (now < proof.asOf || now > proof.validUntil) throw new Error('PROOF_EXPIRED');
    if (now > request.deadline) throw new Error('REDEMPTION_EXPIRED');
    if (
      proof.asset !== request.asset ||
      proof.inventoryAmount !== request.inventoryAmount ||
      proof.expectedAssets !== request.expectedAssets ||
      proof.recipient !== request.recipient ||
      proof.issuerReference !== request.issuerReference
    ) {
      throw new Error('PROOF_BINDING');
    }
    if (proof.receivedAssets < 0n || proof.receivedAssets > proof.expectedAssets) {
      throw new Error('PROOF_AMOUNT');
    }
    this.usedProofs.add(proof.requestDigest);
    request.settled = true;
    return {
      requestId: request.id,
      receivedAssets: proof.receivedAssets,
      realizedLoss: request.expectedAssets - proof.receivedAssets,
    };
  }

  get(requestId: number): RedemptionRequest & { readonly settled: boolean } {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('REDEMPTION_UNKNOWN');
    return { ...request };
  }
}
