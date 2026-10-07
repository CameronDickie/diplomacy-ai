import { defineConfig, devices } from '@playwright/test';

const port = process.env.E2E_PORT ?? '3999';
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'report' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Requires `npm run build` first; the server serves the built client.
  webServer: { command: 'node e2e/serve.mjs', cwd: '..', url: `http://127.0.0.1:${port}/healthz`, reuseExistingServer: false, timeout: 60_000 },
});
