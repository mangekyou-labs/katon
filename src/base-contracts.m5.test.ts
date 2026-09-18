import { describe, expect, it } from 'vitest';
import {
  B20_GUARD_ABI,
  ERC20_ABI,
  LIQUIDITY_FACILITY_ABI,
  ORACLE_GUARD_ABI,
  RFQ_ROUTER_SWAP_EXECUTE_ABI,
  BASE_CONTRACT_ABIS,
} from '../packages/base-contracts/src/index';

describe('M5 client contract interfaces', () => {
  it('exports read/write ABIs for each browser transaction boundary', () => {
    const names = (abi: readonly { name?: string }[]) => abi.map((item) => item.name).filter(Boolean);
    expect(names(ERC20_ABI)).toEqual(expect.arrayContaining(['allowance', 'approve', 'balanceOf', 'decimals']));
    expect(names(LIQUIDITY_FACILITY_ABI)).toEqual(expect.arrayContaining([
      'asset', 'deposit', 'withdraw', 'requestWithdraw', 'claimWithdraw', 'quoteUsdcCapacity',
      'setAdapterAllowed', 'allocate', 'deallocate', 'setHaircutWad', 'setQuotePaused',
    ]));
    expect(names(ORACLE_GUARD_ABI)).toEqual(expect.arrayContaining(['snapshot', 'requireFresh', 'configureFeed']));
    expect(names(B20_GUARD_ABI)).toEqual(expect.arrayContaining(['multiplierWad', 'scaledBalanceOf', 'requireTransferAndSeizeLive']));
    expect(names(BASE_CONTRACT_ABIS.routerSwap)).toContain('executeSwapRoute');
    expect(BASE_CONTRACT_ABIS.routerSwap).toEqual(RFQ_ROUTER_SWAP_EXECUTE_ABI);
  });
});
