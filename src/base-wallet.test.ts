import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BASE_WALLET_SELECTORS,
  ROLE_ACCOUNT_INDICES,
  createNextSrPChild,
  selectAccountByIndex,
  selectRoleAccount,
} from '../tools/base-wallet-lib.mjs';

type FakeLocatorOptions = {
  countValues?: number[];
  revealCountOnNthWait?: number;
};

type FakeNetworkState = {
  calls: string[];
  generation: number;
  selectedTab: 'Popular' | 'Custom';
  pickerOpen: boolean;
  selectedNetwork?: string;
  networkRowGenerations: number[];
};

class FakeLocator {
  private readonly countValues: number[];
  private readonly revealCountOnNthWait?: number;
  private readonly sharedState: { revealed: boolean };

  public constructor(
    private readonly name: string,
    private readonly calls: string[],
    options: FakeLocatorOptions = {},
    sharedState: { revealed: boolean } = { revealed: false },
    private readonly index?: number,
  ) {
    this.countValues = [...(options.countValues ?? [])];
    this.revealCountOnNthWait = options.revealCountOnNthWait;
    this.sharedState = sharedState;
  }

  public async click(): Promise<void> {
    this.calls.push(`${this.name}.click`);
  }

  public async count(): Promise<number> {
    const value = this.revealCountOnNthWait === undefined
      ? (this.countValues.length > 0 ? this.countValues.shift()! : 0)
      : (this.sharedState.revealed ? this.revealCountOnNthWait : 1);
    this.calls.push(`${this.name}.count:${value}`);
    return value;
  }

  public last(): FakeLocator {
    this.calls.push(`${this.name}.last`);
    return this;
  }

  public nth(index: number): FakeLocator {
    this.calls.push(`${this.name}.nth:${index}`);
    return new FakeLocator(this.name, this.calls, {
      revealCountOnNthWait: this.revealCountOnNthWait,
    }, this.sharedState, index);
  }

  public async waitFor(options?: { state?: string }): Promise<void> {
    if (this.index !== undefined && this.index > 0 && this.revealCountOnNthWait !== undefined) {
      this.sharedState.revealed = true;
    }
    this.calls.push(`${this.name}.waitFor:${options?.state ?? 'attached'}`);
  }

  public getByRole(role: string): FakeLocator {
    this.calls.push(`${this.name}.getByRole:${role}`);
    return this;
  }

  public getByTestId(testId: string): FakeLocator {
    this.calls.push(`${this.name}.getByTestId:${testId}`);
    return new FakeLocator(`testid:${testId}`, this.calls);
  }

  public async fill(value: string): Promise<void> {
    this.calls.push(`${this.name}.fill:${value}`);
  }
}

class FakeNetworkLocator {
  public constructor(
    private readonly state: FakeNetworkState,
    private readonly kind: string,
    private readonly generation: number,
  ) {}

  private assertFresh(): void {
    if (this.generation !== this.state.generation) {
      throw new Error(`STALE_NETWORK_LOCATOR:${this.kind}:${this.generation}`);
    }
  }

  public async click(): Promise<void> {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.click`);
    if (this.kind === 'sort-by-networks') {
      this.state.pickerOpen = true;
    } else if (this.kind.startsWith('tab:')) {
      this.state.selectedTab = this.kind.slice('tab:'.length) as 'Popular' | 'Custom';
      this.state.generation += 1;
    } else if (this.kind === 'network-row') {
      this.state.selectedNetwork = 'Base Sepolia';
      this.state.pickerOpen = false;
    }
  }

  public async count(): Promise<number> {
    this.assertFresh();
    const visible = (this.kind === 'network-name' || this.kind === 'network-row')
      && this.state.selectedTab === 'Custom';
    const count = visible ? 1 : 0;
    this.state.calls.push(`${this.kind}.count:${count}`);
    return count;
  }

  public async fill(value: string): Promise<void> {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.fill:${value}`);
    this.state.generation += 1;
  }

  public async getAttribute(name: string): Promise<string | null> {
    this.assertFresh();
    if (this.kind.startsWith('tab:') && name === 'aria-selected') {
      return this.kind.slice('tab:'.length) === this.state.selectedTab ? 'true' : 'false';
    }
    return null;
  }

  public getByRole(role: string, options?: { name?: string }): FakeNetworkLocator {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.getByRole:${role}:${options?.name ?? ''}`);
    if (role === 'tab') return new FakeNetworkLocator(this.state, `tab:${options?.name ?? ''}`, this.state.generation);
    return new FakeNetworkLocator(this.state, `${this.kind}:${role}`, this.state.generation);
  }

  public getByTestId(testId: string): FakeNetworkLocator {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.getByTestId:${testId}`);
    if (testId === 'network-list-search') {
      throw new Error('NETWORK_SEARCH_INPUT_NOT_PRESENT');
    }
    return new FakeNetworkLocator(this.state, `testid:${testId}`, this.state.generation);
  }

  public getByText(text: string): FakeNetworkLocator {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.getByText:${text}`);
    return new FakeNetworkLocator(this.state, 'network-name', this.state.generation);
  }

  public filter(): FakeNetworkLocator {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.filter`);
    return new FakeNetworkLocator(this.state, this.kind, this.state.generation);
  }

  public last(): FakeNetworkLocator {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.last`);
    return new FakeNetworkLocator(this.state, this.kind, this.state.generation);
  }

  public nth(): FakeNetworkLocator {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.nth`);
    return new FakeNetworkLocator(this.state, this.kind, this.state.generation);
  }

  public locator(): FakeNetworkLocator {
    this.assertFresh();
    this.state.calls.push(`${this.kind}.locator`);
    this.state.networkRowGenerations.push(this.state.generation);
    return new FakeNetworkLocator(this.state, 'network-row', this.state.generation);
  }

  public async isVisible(): Promise<boolean> {
    this.assertFresh();
    if (this.kind === 'modal-header-close-button') return false;
    if (this.kind === 'account-options-menu-button') return !this.state.pickerOpen;
    return (this.kind === 'network-name' || this.kind === 'network-row')
      && this.state.selectedTab === 'Custom';
  }

  public async waitFor(): Promise<void> {
    this.assertFresh();
  }
}

function fakeRerenderingNetworkPage() {
  const state: FakeNetworkState = {
    calls: [],
    generation: 0,
    selectedTab: 'Popular',
    pickerOpen: false,
    networkRowGenerations: [],
  };

  const page = {
    state,
    async bringToFront(): Promise<void> {
      state.calls.push('page.bringToFront');
    },
    getByTestId(testId: string): FakeNetworkLocator {
      state.calls.push(`page.getByTestId:${testId}`);
      return new FakeNetworkLocator(state, testId, state.generation);
    },
    getByRole(role: string): FakeNetworkLocator {
      state.calls.push(`page.getByRole:${role}`);
      return new FakeNetworkLocator(state, role, state.generation);
    },
  };

  return page;
}

function fakeWalletPage(
  countValues: number[],
  forbiddenTestIds: string[] = [],
  locatorOptions: FakeLocatorOptions = {},
) {
  const calls: string[] = [];
  const cells = new FakeLocator('cells', calls, { countValues, ...locatorOptions });

  const page = {
    calls,
    async bringToFront(): Promise<void> {
      calls.push('page.bringToFront');
    },
    locator(selector: string): FakeLocator {
      calls.push(`page.locator:${selector}`);
      if (selector !== BASE_WALLET_SELECTORS.accountCell) {
        throw new Error(`unexpected selector: ${selector}`);
      }
      return cells;
    },
    getByTestId(testId: string): FakeLocator {
      calls.push(`page.getByTestId:${testId}`);
      if (forbiddenTestIds.includes(testId)) {
        throw new Error(`forbidden selector used: ${testId}`);
      }
      return new FakeLocator(`testid:${testId}`, calls);
    },
    getByLabel(label: string): FakeLocator {
      calls.push(`page.getByLabel:${label}`);
      return new FakeLocator(`label:${label}`, calls);
    },
  };

  return page;
}

describe('MetaMask 13.17 account-cell wallet automation', () => {
  it('waits for the newly indexed account cell when MetaMask renders the count asynchronously', async () => {
    const page = fakeWalletPage([], [], { revealCountOnNthWait: 2 });

    await expect(createNextSrPChild(page, 'Depositor')).resolves.toBe(2);
    expect(page.calls).toContain('cells.nth:1');
  });

  it('creates the next SRP child, verifies the count, renames it, and selects it', async () => {
    const page = fakeWalletPage([1, 2]);

    const count = await createNextSrPChild(page, 'Depositor');

    expect(count).toBe(2);
    expect(page.calls).toEqual([
      'page.bringToFront',
      'page.getByTestId:account-menu-icon',
      'testid:account-menu-icon.click',
      'page.locator:.multichain-account-cell',
      'cells.count:1',
      'page.getByTestId:add-multichain-account-button',
      'testid:add-multichain-account-button.click',
      'cells.nth:1',
      'cells.waitFor:visible',
      'cells.count:2',
      'cells.last',
      'cells.getByTestId:multichain-account-cell-end-accessory',
      'testid:multichain-account-cell-end-accessory.click',
      'page.getByLabel:Rename',
      'label:Rename.click',
      'page.getByTestId:account-name-input',
      'testid:account-name-input.getByRole:textbox',
      'testid:account-name-input.fill:Depositor',
      'page.getByLabel:Confirm',
      'label:Confirm.click',
      'cells.last',
      'cells.click',
    ]);
  });

  it('selects operator, depositor, and LP by deterministic ordinal', async () => {
    expect(ROLE_ACCOUNT_INDICES).toEqual({ operator: 0, depositor: 1, lp: 2 });

    const page = fakeWalletPage([3]);
    await selectRoleAccount(page, 'lp');

    expect(page.calls).toContain('cells.nth:2');
    expect(page.calls.at(-1)).toBe('cells.click');
  });

  it('rejects an ordinal when the account-cell count is too small', async () => {
    const page = fakeWalletPage([2]);

    await expect(selectAccountByIndex(page, 2)).rejects.toThrow(
      'BASE_QA_ACCOUNT_INDEX:2:2',
    );
  });

  it('reacquires the picker, tab, and network row after Popular-to-Custom rerenders', async () => {
    const { switchBaseQaNetwork } = await import('../tools/base-wallet-lib.mjs') as unknown as {
      switchBaseQaNetwork: (page: unknown, networkName: string) => Promise<void>;
    };
    const page = fakeRerenderingNetworkPage();

    await switchBaseQaNetwork(page, 'Base Sepolia');

    expect(page.state.selectedNetwork).toBe('Base Sepolia');
    expect(page.state.networkRowGenerations.length).toBeGreaterThan(0);
    expect(page.state.networkRowGenerations.at(-1)).toBe(page.state.generation);
    expect(page.state.calls.filter((call) => call.includes('tab:Popular.click')).length).toBe(0);
    expect(page.state.calls.filter((call) => call.includes('tab:Custom.click')).length).toBe(1);
    expect(page.state.calls.filter((call) => call.includes('getByText:Base Sepolia')).length).toBeGreaterThanOrEqual(2);
  });

  it('does not use DOM evaluation, private-key import, or obsolete add-wallet fallbacks', async () => {
    const forbidden = [
      'account-list-add-wallet-button',
      'add-wallet-modal-import-account',
    ];
    const page = fakeWalletPage([1, 2], forbidden);

    await createNextSrPChild(page, 'LP');

    const source = readFileSync(
      join(process.cwd(), 'tools/base-qa.mjs'),
      'utf8',
    );
    expect(source).not.toMatch(/\.evaluate(?:All)?\s*\(/u);
    expect(source).not.toContain('waitForFunction');
    expect(source).not.toContain('account-list-add-wallet-button');
    expect(source).not.toContain('add-wallet-modal-import-account');
    expect(source).not.toContain('importPk');
  });
});
