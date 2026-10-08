import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/offline/**',
  workers: 1,
  timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:4311', browserName: 'chromium', viewport: { width: 1512, height: 982 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm start --demo', url: 'http://127.0.0.1:4311', timeout: 20000, reuseExistingServer: false, env: { PORT: '4311', WORKBENCH_STATE_FILE: `.workbench/e2e-${Date.now()}.json` } },
});
