import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PLAYWRIGHT_PORT || 4178);
const baseURL = `http://127.0.0.1:${port}`;
const runId = `${process.pid}-${Date.now()}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: {
    command: "npm run build && npm start",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: join(tmpdir(), `cc-webui-e2e-data-${runId}`),
      WORKSPACE_ROOT: join(tmpdir(), `cc-webui-e2e-workspaces-${runId}`),
      ADMIN_PASSWORD: "e2e-admin-password",
      CLAUDE_COMMAND: "__e2e_do_not_execute_claude__",
      BACKUP_ENABLED: "false",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
});
