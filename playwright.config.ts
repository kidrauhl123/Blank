import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "**/*.pw.ts", workers: 1,
  // E2E 跑在开发服务器上，路由首次访问时才编译，请求可能排队数秒；断言等待放宽到 10 秒。
  expect: { timeout: 10_000 },
  use: { baseURL: "http://localhost:3109", viewport: { width: 430, height: 932 },
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {} },
  webServer: [
    ...(process.env.BANKPILOT_MODEL_E2E === "1" ? [{ command: "node e2e/model-server.mjs", url: "http://127.0.0.1:54230/health", reuseExistingServer: false }] : []),
    { command: "npm run dev -- --port 3109", url: "http://localhost:3109", reuseExistingServer: !process.env.CI },
  ],
});
