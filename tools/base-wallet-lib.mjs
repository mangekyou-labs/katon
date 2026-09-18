export const BASE_WALLET_SELECTORS = Object.freeze({
  accountMenu: 'account-menu-icon',
  accountCell: '.multichain-account-cell',
  createChild: 'add-multichain-account-button',
  cellAccessory: 'multichain-account-cell-end-accessory',
  renameLabel: 'Rename',
  accountNameInput: 'account-name-input',
  confirmLabel: 'Confirm',
  networkPickerTrigger: 'sort-by-networks',
  networkPickerHeading: 'Select network',
  networkPickerClose: 'modal-header-close-button',
  walletHome: 'account-options-menu-button',
});

export const ROLE_ACCOUNT_INDICES = Object.freeze({
  operator: 0,
  depositor: 1,
  lp: 2,
});

const NETWORK_TABS = Object.freeze(['Popular', 'Custom']);
const NETWORK_LOOKUP_ATTEMPTS = 3;

function networkPicker(page) {
  return page
    .getByRole('dialog')
    .filter({
      has: page.getByRole('heading', {
        name: BASE_WALLET_SELECTORS.networkPickerHeading,
        exact: true,
      }),
    })
    .last();
}

async function selectNetworkRow(page, networkName) {
  for (const tabName of NETWORK_TABS) {
    for (let attempt = 0; attempt < NETWORK_LOOKUP_ATTEMPTS; attempt += 1) {
      try {
        const picker = networkPicker(page);
        await picker.waitFor({ state: 'visible' });

        const tab = picker.getByRole('tab', { name: tabName, exact: true });
        if ((await tab.getAttribute('aria-selected')) !== 'true') {
          await tab.click();
          // MetaMask 13.17 replaces the dialog and tab panel here. The next
          // attempt intentionally reacquires every locator from the page.
          continue;
        }

        // The picker searches by the exact visible network label. MetaMask
        // can replace the dialog while the selected tab's list settles, so
        // this label and its row are reacquired on every attempt.
        const networkNames = picker.getByText(networkName, { exact: true });
        const count = await networkNames.count();
        for (let index = 0; index < count; index += 1) {
          const networkLabel = networkNames.nth(index);
          if (!(await networkLabel.isVisible().catch(() => false))) continue;

          // The exact label is not the interactive element in recent
          // MetaMask builds. Select its enclosing network row instead.
          const row = networkLabel.locator(
            'xpath=ancestor::*[starts-with(@data-testid, "network-list-item-")][1]',
          );
          if ((await row.count()) > 0 && (await row.isVisible().catch(() => false))) {
            await row.click();
            return;
          }
          await networkLabel.click();
          return;
        }
      } catch {
        // A transition can detach a locator between any two reads. Retry with
        // fresh dialog-scoped locators before moving to the next tab.
      }
    }
  }

  throw new Error(`BASE_QA_NETWORK_NOT_FOUND:${networkName}`);
}

async function closeNetworkPicker(page) {
  const closeButton = page.getByTestId(BASE_WALLET_SELECTORS.networkPickerClose);
  if (!(await closeButton.isVisible().catch(() => false))) return;
  await closeButton.click();
  await closeButton.waitFor({ state: 'hidden' }).catch(() => undefined);
}

export async function switchBaseQaNetwork(page, networkName) {
  const requestedName = typeof networkName === 'string' ? networkName : String(networkName);
  try {
    if (requestedName.trim() === '') throw new Error('empty network name');

    await page.bringToFront();
    await page.getByTestId(BASE_WALLET_SELECTORS.walletHome).waitFor({ state: 'visible' });
    const pickerTrigger = page.getByTestId(BASE_WALLET_SELECTORS.networkPickerTrigger);
    await pickerTrigger.waitFor({ state: 'visible' });
    await pickerTrigger.click();

    await selectNetworkRow(page, requestedName);
    await closeNetworkPicker(page);
    await page.getByTestId(BASE_WALLET_SELECTORS.walletHome).waitFor({ state: 'visible' });
  } catch {
    throw new Error(`BASE_QA_NETWORK_NOT_FOUND:${requestedName}`);
  }
}

async function openAccountMenu(page) {
  await page.bringToFront();
  await page.getByTestId(BASE_WALLET_SELECTORS.accountMenu).click();
}

export async function createNextSrPChild(page, accountName) {
  if (typeof accountName !== 'string' || accountName.trim() === '') {
    throw new Error('BASE_QA_ACCOUNT_NAME');
  }

  await openAccountMenu(page);
  const accountCells = page.locator(BASE_WALLET_SELECTORS.accountCell);
  const before = await accountCells.count();

  await page.getByTestId(BASE_WALLET_SELECTORS.createChild).click();
  await accountCells.nth(before).waitFor({ state: 'visible' });
  const after = await accountCells.count();
  if (after !== before + 1) {
    throw new Error(`BASE_QA_ACCOUNT_COUNT:${before}:${after}`);
  }

  await accountCells.last().getByTestId(BASE_WALLET_SELECTORS.cellAccessory).click();
  await page.getByLabel(BASE_WALLET_SELECTORS.renameLabel, { exact: true }).click();
  await page
    .getByTestId(BASE_WALLET_SELECTORS.accountNameInput)
    .getByRole('textbox')
    .fill(accountName);
  await page.getByLabel(BASE_WALLET_SELECTORS.confirmLabel, { exact: true }).click();
  await accountCells.last().click();
  return after;
}

export async function selectAccountByIndex(page, index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`BASE_QA_ACCOUNT_INDEX:${String(index)}`);
  }

  await openAccountMenu(page);
  const accountCells = page.locator(BASE_WALLET_SELECTORS.accountCell);
  const count = await accountCells.count();
  if (index >= count) throw new Error(`BASE_QA_ACCOUNT_INDEX:${index}:${count}`);
  await accountCells.nth(index).click();
  return index;
}

export async function selectRoleAccount(page, role) {
  const index = ROLE_ACCOUNT_INDICES[role];
  if (index === undefined) throw new Error(`BASE_QA_ROLE_ACCOUNT:${String(role)}`);
  return selectAccountByIndex(page, index);
}
