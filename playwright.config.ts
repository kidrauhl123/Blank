import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "**/*.pw.ts", workers: 1,
  use: { baseURL: "http://localhost:3109", viewport: { width: 430, height: 932 },
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {} },
  webServer: [
    ...(process.env.BANKPILOT_MODEL_E2E === "1" ? [{ command: "node e2e/model-server.mjs", url: "http://127.0.0.1:54230/health", reuseExistingServer: false }] : []),
    { command: "npm run dev -- --port 3109", url: "http://localhost:3109", reuseExistingServer: !process.env.CI },
  ],
});
