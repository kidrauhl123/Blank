import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "**/*.pw.ts", workers: 1,
  use: { baseURL: "http://localhost:3109", viewport: { width: 430, height: 932 },
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {} },
  webServer: { command: "npm run dev -- --port 3109", url: "http://localhost:3109", reuseExistingServer: !process.env.CI },
});
