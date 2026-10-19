import { test, expect } from "@playwright/test";

// This suite uses real demo endpoints and PostgreSQL; no browser route substitutes.
test.skip(process.env.BANKPILOT_DEMO_E2E !== "1", "Requires an opt-in demo server and disposable database");

test("five profiles enter real accounts and switch without carrying an Agent run", async ({ page }) => {
  await page.goto("/");
  const names = ["小土豆", "小板栗", "小苹果", "小西瓜", "小橘子"];
  await expect(page.getByRole("heading", { name: "选个小伙伴" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^以.*进入$/ })).toHaveCount(5);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText("小番茄")).toHaveCount(0);
  const identities = new Set<string>();
  for (const name of names) {
    await page.getByRole("button", { name: `以${name}进入` }).click();
    await expect(page.getByRole("button", { name: "AI 助手", exact: true })).toBeVisible();
    const overview = await (await page.request.get("/api/bootstrap")).json();
    expect(overview.customer.display_name).toBe(name);
    expect(overview.totalMinor).toBeGreaterThan(0);
    expect(overview.transactions).toHaveLength(17);
    expect(overview.cards).toHaveLength(2);
    expect(overview.subscriptions).toHaveLength(2);
    identities.add(overview.accounts[0].id);
    await page.evaluate(() => sessionStorage.setItem("bankpilot-app-agent-run", "stale-other-identity"));
    await page.getByRole("button", { name: "个人中心" }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "切换用户" }).click();
    await expect(page.getByRole("heading", { name: "选个小伙伴" })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("bankpilot-app-agent-run"))).toBeNull();
  }
  expect(identities.size).toBe(5);
});

test("demo selection rejects missing and foreign origins, arbitrary UUIDs and tokens", async ({ request, baseURL }) => {
  expect((await request.post("/api/auth/demo", { data: { profileKey: "potato" } })).status()).toBe(403);
  expect((await request.post("/api/auth/demo", { headers: { origin: "https://foreign.invalid" }, data: { profileKey: "potato" } })).status()).toBe(403);
  expect((await request.post("/api/auth/demo", { headers: { origin: baseURL! }, data: { profileKey: "00000000-0000-4000-8000-000000000001" } })).status()).toBe(404);
  expect((await request.post("/api/auth/demo", { headers: { origin: baseURL!, authorization: "Bearer arbitrary" }, data: { profileKey: "potato" } })).status()).toBe(403);
  for (const path of ["login", "register"]) expect((await request.post(`/api/auth/${path}`, { headers: { origin: baseURL! }, data: {} })).status()).toBe(404);
});
