/**
 * demo.spec.js — the Playwright test that run_playwright_test executes.
 *
 * Two tests pass, one fails on purpose: it asserts the wrong heading text,
 * so the runner's failure report (title + error + file:line) shows up in
 * the demo transcript. A runner that only ever passes proves nothing.
 */
import { test, expect } from '@playwright/test';

const DEMO_URL = process.env.DEMO_URL || 'http://localhost:8901/demo-page.html';

test('demo page has the shop heading', async ({ page }) => {
  await page.goto(DEMO_URL);
  await expect(page.getByRole('heading', { name: 'QA Pilot demo shop' })).toBeVisible();
});

test('adding to cart shows a confirmation', async ({ page }) => {
  await page.goto(DEMO_URL);
  await page.getByTestId('qty-input').fill('2');
  await page.getByTestId('add-to-cart').click();
  await expect(page.getByRole('status')).toContainText('Added 2 × Wireless headphones');
});

test('search box accepts text (intentionally failing)', async ({ page }) => {
  await page.goto(DEMO_URL);
  await page.getByLabel('Search products').fill('headphones');
  // Wrong on purpose: the page says "demo shop", not "demo store".
  await expect(page.getByRole('heading', { name: 'QA Pilot demo store' })).toBeVisible();
});
