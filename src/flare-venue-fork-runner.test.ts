import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assertForkPlanExecution,
  forgeCaseArgs,
  rpcEvidenceOrigin,
  runTimedForgeCase,
  validateForkPlan,
} from '../tools/run-flare-venue-fork-tests.mjs';

const validPlan = (overrides = {}) => ({
  venue: 'Clearpool',
  chainId: 14,
  forkBlock: 65_078_017,
  authoritativeReference: 'https://docs.clearpool.finance/',
  cases: [
    { name: 'deposit', testName: 'testForkClearpoolDeposit' },
    { name: 'accrual-read', testName: 'testForkClearpoolAccrualRead' },
    { name: 'withdrawal', testName: 'testForkClearpoolWithdrawal' },
    { name: 'pause', testName: 'testForkClearpoolPause' },
    { name: 'zero-liquidity', testName: 'testForkClearpoolZeroLiquidity' },
    { name: 'revert', testName: 'testForkClearpoolRevert' },
    { name: 'rounding-loss', testName: 'testForkClearpoolRoundingLoss' },
    { name: 'binding-rejection', testName: 'testForkClearpoolBindingRejection' },
  ],
  ...overrides,
});

describe('Flare venue fork evidence runner', () => {
  it('forks only through the declared RPC without unrelated selector-network lookups', () => {
    expect(forgeCaseArgs('testForkKineticOfficialBindings')).toEqual([
      'test',
      '--offline',
      '--root',
      'contracts/flare',
      '--match-contract',
      'VenueMainnetForkTest',
      '--match-test',
      'testForkKineticOfficialBindings',
      '-vv',
    ]);
  });

  it('rejects plans that relabel one passing test as multiple business cases', () => {
    expect(() => validateForkPlan({
      ...validPlan(),
      cases: [
        { name: 'deposit', testName: 'testForkKineticRoundTrip' },
        { name: 'withdrawal', testName: 'testForkKineticRoundTrip' },
      ],
    })).toThrow('FORK_PLAN_TEST_DUPLICATE:testForkKineticRoundTrip');
  });

  it('rejects Foundry test-name regex injection before execution', () => {
    expect(() => validateForkPlan({
      ...validPlan(),
      cases: [{ name: 'deposit', testName: 'testForkDeposit|testForkWithdrawal' }],
    })).toThrow('FORK_PLAN_TEST_NAME_INVALID');
  });

  it.each([
    ['wrong-chain', { chainId: 114 }, 'FORK_PLAN_CHAIN_ID'],
    ['missing-block', { forkBlock: 0 }, 'FORK_PLAN_BLOCK'],
    ['non-authoritative-reference', { authoritativeReference: 'local-notes' }, 'FORK_PLAN_REFERENCE_HTTPS'],
  ])('rejects a %s plan before execution', (_label, overrides, message) => {
    expect(() => validateForkPlan(validPlan(overrides))).toThrow(message);
  });

  it('rejects execution at a block other than the plan-pinned block', () => {
    expect(() => assertForkPlanExecution(validPlan(), { chainId: 14, forkBlock: 65_078_018 }))
      .toThrow('FORK_PLAN_BLOCK_MISMATCH:65078017:65078018');
  });

  it('rejects an incomplete business-operation matrix before fork execution', () => {
    expect(() => validateForkPlan(validPlan({
      cases: [{ name: 'deposit', testName: 'testForkClearpoolDeposit' }],
    }))).toThrow('FORK_PLAN_CONFORMANCE_INVALID:VENUE_CONFORMANCE_CASE_MISSING:accrual-read');
  });

  it('validates the checked-in Clearpool mainnet plan with unique real-operation tests', () => {
    const plan = JSON.parse(readFileSync(
      new URL('../fixtures/flare/venue-fork-clearpool-mainnet.json', import.meta.url),
      'utf8',
    ));
    expect(validateForkPlan(plan)).toBe(plan);
    expect(plan.cases.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'deposit',
      'accrual-read',
      'withdrawal',
      'pause',
      'zero-liquidity',
      'revert',
      'rounding-loss',
      'binding-rejection',
    ]));
  });

  it('validates the checked-in Kinetic mainnet plan including every liquidation gate', () => {
    const plan = JSON.parse(readFileSync(
      new URL('../fixtures/flare/venue-fork-kinetic-mainnet.json', import.meta.url),
      'utf8',
    ));
    expect(validateForkPlan(plan)).toBe(plan);
    expect(plan.cases.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'deposit',
      'accrual-read',
      'withdrawal',
      'pause',
      'zero-liquidity',
      'revert',
      'rounding-loss',
      'binding-rejection',
      'liquidation-success',
      'healthy-rejection',
      'close-factor-rejection',
      'shortfall-rejection',
      'approval-residue',
      'recipient-mismatch',
      'atomic-rollback',
      'liquidator-allowlist-rejection',
    ]));
  });

  it('binds Kinetic liquidation eligibility through the official verifier ABI', () => {
    const forkHarness = readFileSync(
      new URL('../contracts/flare/test/VenueMainnetFork.t.sol', import.meta.url),
      'utf8',
    );

    expect(forkHarness).toContain('liquidatorsWhitelistVerifier()');
    expect(forkHarness).toContain('interface IKineticForkLiquidatorAllowList');
    expect(forkHarness).toContain('KINETIC_LIQUIDATOR_ALLOWLIST');
    expect(forkHarness).toContain('.allowed(adapter)');
    expect(forkHarness).not.toContain('liquidatable()');
    expect(forkHarness).not.toContain('isInLiquidateWhiteList');
  });

  it('requires an unauthorized Kinetic rejection before owner-mediated fork setup', () => {
    const plan = JSON.parse(readFileSync(
      new URL('../fixtures/flare/venue-fork-kinetic-mainnet.json', import.meta.url),
      'utf8',
    ));
    const forkHarness = readFileSync(
      new URL('../contracts/flare/test/VenueMainnetFork.t.sol', import.meta.url),
      'utf8',
    );

    expect(plan.cases).toContainEqual({
      name: 'liquidator-allowlist-rejection',
      testName: 'testForkKineticLiquidatorAllowlistRejection',
    });
    expect(forkHarness).toContain('function owner() external view returns (address);');
    expect(forkHarness).toContain('function allow(address account) external;');
    expect(forkHarness).toContain('function testForkKineticLiquidatorAllowlistRejection()');
    expect(forkHarness).toContain('require(!allowList.allowed(adapter), "KINETIC_ADAPTER_ALREADY_ALLOWED");');
    expect(forkHarness).toContain('vm.prank(allowListOwner);');
    expect(forkHarness).toContain('allowList.allow(adapter);');
    expect(forkHarness).not.toContain('vm.store(');
    expect(forkHarness).not.toContain('vm.etch(');
  });

  it('records only the RPC origin and strips credentials, paths, and query parameters', () => {
    expect(rpcEvidenceOrigin('https://user:pass@rpc.example/v1/secret?apiKey=secret'))
      .toBe('https://rpc.example');
  });

  it('records measured elapsed time only for one genuinely passing fork test', async () => {
    const now = vi.fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(16.75);
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      output: 'Suite result: ok. 1 passed; 0 failed; 0 skipped',
    });

    await expect(runTimedForgeCase({ name: 'deposit', testName: 'testForkDeposit', execute, now }))
      .resolves.toEqual({ name: 'deposit', result: 'pass', elapsedMs: 6.75 });
  });

  it.each([
    ['skipped', { exitCode: 0, output: 'Suite result: ok. 0 passed; 0 failed; 1 skipped' }],
    ['failed', { exitCode: 1, output: 'Suite result: FAILED. 0 passed; 1 failed; 0 skipped' }],
    ['ambiguous', { exitCode: 0, output: 'Compiler run successful!' }],
    ['multiple', { exitCode: 0, output: 'Suite result: ok. 2 passed; 0 failed; 0 skipped' }],
  ])('rejects %s forge output instead of manufacturing evidence', async (_label, execution) => {
    await expect(runTimedForgeCase({
      name: 'deposit',
      testName: 'testForkDeposit',
      execute: async () => execution,
      now: () => 1,
    })).rejects.toThrow('FORK_TEST_NOT_EXACTLY_ONE_PASS');
  });
});
