import { expect, test } from "@playwright/test";

const retiredPaths = [
  "/developers", "/api/mcp", "/api/openapi", "/api/v1/developer/tokens",
  "/api/v1/developer/tokens/00000000-0000-4000-8000-000000000001",
];

for (const path of retiredPaths) {
  for (const method of ["GET", "POST"]) {
    test(`retired external entry ${method} ${path} returns 404`, async ({ request, baseURL }) => {
      const response = await request.fetch(path, {
        method, headers: { origin: baseURL!, authorization: "Bearer retired-external-token" },
        ...(method === "POST" ? { data: {} } : {}),
      });
      expect(response.status()).toBe(404);
    });
  }
}

const bankingRequests = [
  { path: "/api/bootstrap", method: "GET" },
  { path: "/api/v1/operations/TRF-EXTERNAL-RETIRED", method: "GET" },
  { path: "/api/v1/transfers/prepare", method: "POST" },
];

for (const { path, method } of bankingRequests) {
  test(`retired Bearer access to ${path} is rejected before any bank query`, async ({ request, baseURL }) => {
    const response = await request.fetch(path, {
      method, headers: { origin: baseURL!, authorization: "Bearer retired-external-token" },
      ...(method === "POST" ? { data: {} } : {}),
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: "BANK_APP_SESSION_REQUIRED" });
  });

  test(`anonymous access to ${path} still requires a bank session`, async ({ request, baseURL }) => {
    const response = await request.fetch(path, {
      method, headers: { origin: baseURL! }, ...(method === "POST" ? { data: {} } : {}),
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: "AUTHENTICATION_REQUIRED" });
  });
}

test("a real bank session rejects external headers and untrusted write origins while retaining normal access", async ({ page, baseURL }) => {
  test.skip(process.env.BANKPILOT_DEMO_E2E !== "1", "Requires the disposable database demo server");
  await page.goto("/");
  await page.getByRole("button", { name: "以小土豆进入" }).click();
  await expect(page.getByRole("button", { name: "打开悬浮助手" })).toBeVisible();
  const bootstrap = await page.request.get("/api/bootstrap");
  expect(bootstrap.status()).toBe(200);
  const before = await bootstrap.json();
  const origin = new URL(baseURL!).origin;
  const transfer = { fromAccountId: before.accounts[0].id, recipient: "小板栗", amountMinor: 1 };

  for (const authorization of ["Bearer retired-external-token", "Basic dXNlcjpwYXNz", "", "bearer retired-external-token"]) {
    for (const { path, method } of bankingRequests) {
      const response = await page.request.fetch(path, {
        method, headers: { origin, authorization }, ...(method === "POST" ? { data: transfer } : {}),
      });
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ error: "BANK_APP_SESSION_REQUIRED" });
    }
  }

  const otherScheme = new URL(origin);
  otherScheme.protocol = otherScheme.protocol === "http:" ? "https:" : "http:";
  const otherPort = new URL(origin);
  otherPort.port = String(Number(otherPort.port || (otherPort.protocol === "https:" ? 443 : 80)) + 1);
  const writeAttempts: Array<{ name: string; headers: Record<string, string> }> = [
    { name: "missing Origin", headers: {} },
    { name: "different scheme", headers: { origin: otherScheme.origin } },
    { name: "different port", headers: { origin: otherPort.origin } },
    { name: "forged forwarded host", headers: { origin: "https://untrusted.example", "x-forwarded-host": "untrusted.example" } },
  ];
  for (const attempt of writeAttempts) {
    const response = await page.request.post("/api/v1/transfers/prepare", { headers: attempt.headers, data: transfer });
    expect(response.status(), attempt.name).toBe(403);
    expect(await response.json()).toMatchObject({ error: "INVALID_ORIGIN" });
  }

  const normal = await page.request.get("/api/bootstrap");
  expect(normal.status()).toBe(200);
  const after = await normal.json();
  expect(after.customer.id).toBe(before.customer.id);
  expect(after.totalMinor).toBe(before.totalMinor);
  expect(after.transactions).toEqual(before.transactions);
});
