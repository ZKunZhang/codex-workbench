import { defineConfig } from '@playwright/test';

// Fulfill HTML, assets and API requests in the browser; no server is started.
// A localhost origin enables secure-context APIs, matching the real dashboard.
export default defineConfig({
  testDir: './e2e/offline',
  workers: 1,
  timeout: 20000,
  use: { baseURL: 'http://workbench.localhost', browserName: 'chromium', viewport: { width: 1512, height: 982 }, screenshot: 'only-on-failure' },
});
