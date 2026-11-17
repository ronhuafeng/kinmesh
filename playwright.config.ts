import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  globalSetup: './tests/browser/global-setup.ts',
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
    // The workspace's service worker keeps the app's files and receives
    // shares; these tests reach the hub directly, so routes see every call.
    serviceWorkers: 'block',
  },
  reporter: 'list',
});
