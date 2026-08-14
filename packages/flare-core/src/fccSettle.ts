import { getAddress, type Address } from 'viem';

export function expectedRecipientBuyTokenDelta(input: {
  readonly grossOutput: bigint;
  readonly netOutput: bigint;
  readonly recipient: Address;
  readonly feeRecipient: Address;
}): bigint {
  if (input.netOutput > input.grossOutput) {
    throw new Error('NET_EXCEEDS_GROSS');
  }
  return getAddress(input.recipient) === getAddress(input.feeRecipient)
    ? input.grossOutput
    : input.netOutput;
}
