import { test, expect } from '@playwright/test';

test('register, open an account, deposit, tansfer and see history', async ({ page }) => {
  const email = `e2e-${Date.now()}@e2e.neobank.test`;
  const password = 'Secret123!';

  // 1. register -> redirected to /login
  await page.goto('/register');
  await page.getByLabel('Full Name').fill('E2E Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm Password').fill(password);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.waitForURL('**/login');

  // 2. login -> redirected to /dashboard
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/dashboard');

  // 3. empty state
  await expect(page.getByText('No accounts yet')).toBeVisible();

  // 4. open a SAVINGS account via the dialog → card appears
  await page.getByRole('button', { name: 'Create Account' }).click();

  const createDialog = page.getByRole('dialog');
  await expect(createDialog.getByText('Open a new account')).toBeVisible();
  await createDialog.getByLabel('Select Account Type').selectOption('SAVINGS');
  await createDialog.getByRole('button', { name: 'Create Account' }).click();

  // card appears, dialog closes
  const savingsCard = page.locator('[data-slot="card"]').filter({ hasText: 'SAVINGS' });
  await expect(savingsCard).toBeVisible();
  await expect(savingsCard.getByText('₹0.00')).toBeVisible();

  // 5. deposit 1000 → balance shows ₹1,000.00
  await page.getByRole('button', { name: 'Deposit' }).first().click();

  const depositDialog = page.getByRole('dialog');
  await depositDialog.getByLabel('Deposit Amount').fill('1000');
  await depositDialog.getByLabel('Description').fill('Test Deposit');
  await depositDialog.getByRole('button', { name: 'Deposit' }).click();

  // card appears, dialog closes
  await expect(page.getByText('₹1,000.00')).toBeVisible();

  // 6. open a CURRENT account
  await page.getByRole('button', { name: 'Create Account' }).click();

  const createDialog_1 = page.getByRole('dialog');
  await expect(createDialog_1.getByText('Open a new account')).toBeVisible();
  await createDialog_1.getByLabel('Select Account Type').selectOption('CURRENT');
  await createDialog_1.getByRole('button', { name: 'Create Account' }).click();

  // card appears, dialog closes
  const currentCard = page.locator('[data-slot="card"]').filter({ hasText: 'CURRENT' });
  await expect(currentCard).toBeVisible();
  await expect(currentCard.getByText('₹0.00')).toBeVisible();

  // 7. transfer 250 from savings to current
  const savingsId = (await savingsCard.getByRole('link').getAttribute('href'))!.split('/').pop()!;

  const href = await currentCard.getByRole('link').getAttribute('href');
  const currentAccountId = href!.split('/').pop()!;

  await page.getByRole('button', { name: 'Transfer' }).click();
  const transferDialog = page.getByRole('dialog');
  await transferDialog.getByLabel('From Account').selectOption(savingsId);
  await transferDialog.getByLabel('To account').selectOption(currentAccountId);
  await transferDialog.getByLabel('Transfer Amount').fill('250');
  await transferDialog.getByLabel('Description').fill('Test Transfer');
  await transferDialog.getByRole('button', { name: 'Transfer' }).click();

  await expect(savingsCard.getByText('₹750.00')).toBeVisible();
  await expect(currentCard.getByText('₹250.00')).toBeVisible();
  // 8. click "View transactions" → expect a DEPOSIT row
  await page.getByRole('link', { name: 'View transactions' }).first().click();
  await page.waitForURL(`**/accounts/${savingsId}`);
  await expect(page.getByRole('cell', { name: 'DEPOSIT', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'TRANSFER_OUT', exact: true })).toBeVisible();
});
