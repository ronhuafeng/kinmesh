import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/live',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  expect: { timeout: 15_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  reporter: 'list',
});
