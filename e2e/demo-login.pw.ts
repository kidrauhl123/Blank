import { test, expect } from "@playwright/test";

// This suite uses real demo endpoints and PostgreSQL; no browser route substitutes.
test.skip(process.env.BANKPILOT_DEMO_E2E !== "1", "Requires an opt-in demo server and disposable database");

test("one showcase entry enters the real account and re-entry never carries an Agent run", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "欢迎体验 BankPilot" })).toBeVisible();
  // 只有一个体验入口；其他几位是小土豆的朋友，不再出现在登录页。
  await expect(page.getByRole("button", { name: /^以.*进入$/ })).toHaveCount(1);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  for (const name of ["小板栗", "小苹果", "小西瓜", "小橘子"]) await expect(page.getByText(name)).toHaveCount(0);
  const identities = new Set<string>();
  for (let round = 0; round < 2; round++) {
    await page.getByRole("button", { name: "以小土豆进入" }).click();
    await expect(page.getByRole("button", { name: "AI 助手", exact: true })).toBeVisible();
    const overview = await (await page.request.get("/api/bootstrap")).json();
    expect(overview.customer.display_name).toBe("小土豆");
    expect(overview.totalMinor).toBeGreaterThan(0);
    expect(overview.transactions).toHaveLength(22);
    expect(overview.cards).toHaveLength(2);
    expect(overview.subscriptions).toHaveLength(2);
    identities.add(overview.accounts[0].id);
    await page.evaluate(() => sessionStorage.setItem("bankpilot-app-agent-run", "stale-previous-session"));
    await page.getByRole("button", { name: "个人中心" }).click();
    await expect(page.getByRole("heading", { name: "小土豆", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "退出体验" }).click();
    await expect(page.getByRole("heading", { name: "欢迎体验 BankPilot" })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("bankpilot-app-agent-run"))).toBeNull();
  }
  expect(identities.size).toBe(1);
});

test("demo selection rejects missing and foreign origins, arbitrary UUIDs and tokens", async ({ request, baseURL }) => {
  expect((await request.post("/api/auth/demo", { data: { profileKey: "potato" } })).status()).toBe(403);
  expect((await request.post("/api/auth/demo", { headers: { origin: "https://foreign.invalid" }, data: { profileKey: "potato" } })).status()).toBe(403);
  expect((await request.post("/api/auth/demo", { headers: { origin: baseURL! }, data: { profileKey: "00000000-0000-4000-8000-000000000001" } })).status()).toBe(404);
  expect((await request.post("/api/auth/demo", { headers: { origin: baseURL!, authorization: "Bearer arbitrary" }, data: { profileKey: "potato" } })).status()).toBe(403);
  for (const path of ["login", "register"]) expect((await request.post(`/api/auth/${path}`, { headers: { origin: baseURL! }, data: {} })).status()).toBe(404);
});
