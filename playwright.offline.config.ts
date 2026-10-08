import { defineConfig } from '@playwright/test';

// Fulfill HTML, assets and API requests in the browser; no server is started.
export default defineConfig({
  testDir: './e2e/offline',
  workers: 1,
  timeout: 20000,
  use: { baseURL: 'http://workbench.test', browserName: 'chromium', viewport: { width: 1512, height: 982 }, screenshot: 'only-on-failure' },
});
