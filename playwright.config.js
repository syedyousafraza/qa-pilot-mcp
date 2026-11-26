/**
 * Playwright config for qa-pilot-mcp.
 *
 * Uses the Chromium from the standard Playwright cache (installed with
 * `npx playwright install chromium`). Set PLAYWRIGHT_CHROMIUM_PATH to
 * point at an explicit binary instead.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'examples',
  timeout: 30000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
});
