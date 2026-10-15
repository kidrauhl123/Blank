import { expect, test } from "@playwright/test";

test("debug model settings stay outside the assistant and persist only for the current bank session", async ({ page, baseURL, browser }) => {
  test.skip(process.env.BANKPILOT_MODEL_E2E !== "1" || process.env.BANKPILOT_DEMO_E2E !== "1", "Uses disposable bank database and local test model transport");
  await page.goto("/");
  await page.getByRole("button", { name: "以小土豆进入" }).click();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "AI 助手" }).click();
  await expect(page.getByRole("dialog", { name: "BankPilot 悬浮助手" }).getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭助手面板" }).click();
  await page.getByRole("button", { name: "个人中心" }).click();
  await page.getByRole("link", { name: "设置 调试选项" }).click();
  const model = page.getByLabel("助手模型");
  await expect(model).toHaveValue("bank-test-alpha");
  await model.selectOption("bank-test-beta");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await page.reload(); await expect(model).toHaveValue("bank-test-beta");
  const headers = { origin: baseURL! };
  const pageSnapshot = { name: "首页", version: "test-model", text: "模拟银行首页", controls: [] };
  const startedResponse = await page.request.post("/api/agent/app", { headers, data: { command: "start", message: "查信息", page: pageSnapshot } });
  expect(startedResponse.status()).toBe(200);
  const started = await startedResponse.json();
  expect(started).toMatchObject({ model: "bank-test-beta", status: "QUESTION" });
  expect((await page.request.put("/api/v1/settings/model", { headers, data: { model: "bank-test-alpha" } })).status()).toBe(200);
  const restored = await (await page.request.get(`/api/agent/app?id=${started.id}`)).json();
  expect(restored.model).toBe("bank-test-beta");
  const nextResponse = await page.request.post("/api/agent/app", { headers, data: { command: "start", message: "查信息", page: pageSnapshot } });
  const next = await nextResponse.json(); expect(next.model).toBe("bank-test-alpha");
  expect((await page.request.put("/api/v1/settings/model", { headers, data: { model: "not-listed" } })).status()).toBe(422);
  expect((await page.request.put("/api/v1/settings/model", { headers, data: {} })).status()).toBe(400);
  expect((await page.request.put("/api/v1/settings/model", { data: { model: "bank-test-beta" } })).status()).toBe(403);
  expect((await page.request.put("/api/v1/settings/model", { headers: { ...headers, authorization: "Bearer external" }, data: { model: "bank-test-beta" } })).status()).toBe(403);
  for (const id of [started.id, next.id]) expect((await page.request.post("/api/agent/app", { headers, data: { command: "cancel", id } })).status()).toBe(200);
  const another = await browser.newContext();
  try {
    expect((await another.request.post(`${baseURL}/api/auth/demo`, { headers, data: { profileKey: "potato" } })).status()).toBe(200);
    expect(await (await another.request.get(`${baseURL}/api/v1/settings/model`)).json()).toEqual({ model: "bank-test-alpha" });
  } finally { await another.close(); }
});
