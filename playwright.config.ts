import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
});
