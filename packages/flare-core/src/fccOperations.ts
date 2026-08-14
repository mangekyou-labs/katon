import { bytes32Identifier } from './fccEnvelope';
import type { Hex } from 'viem';

/** FCC-compatible right-padded identifiers shared with Solidity and Go. */
export const FCC_OPERATIONS: Readonly<Record<string, Hex>> = Object.freeze({
  RFQ: bytes32Identifier('RFQ'),
  BID: bytes32Identifier('BID'),
  MATCH: bytes32Identifier('MATCH'),
  LIQUIDATION: bytes32Identifier('LIQUIDATION'),
  CREATE: bytes32Identifier('CREATE'),
  CANCEL: bytes32Identifier('CANCEL'),
  SUBMIT: bytes32Identifier('SUBMIT'),
  STANDING: bytes32Identifier('STANDING'),
  QUOTE: bytes32Identifier('QUOTE'),
  FINALIZE: bytes32Identifier('FINALIZE'),
});
