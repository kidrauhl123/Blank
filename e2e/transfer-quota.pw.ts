import { expect, test } from "@playwright/test";

test("a submission-time upgrade refreshes the yellow form to red and requires a new dynamic code", async ({ page }) => {
  const account = { id: "00000000-0000-4000-8000-000000000001", name: "活期账户", masked_no: "•• 1001", account_type: "CHECKING", available_balance_minor: "200000", currency: "CNY", status: "ACTIVE" };
  const draft = { operationId: "TRF-UI-TEST", status: "AWAITING_AUTH", riskLevel: "YELLOW", requiredAuth: "CONFIRM", details: { amountMinor: 60000, sourceAccount: account, recipient: { name: "收款测试用户", phoneMasked: "990****0002", maskedAccount: "•• 1002" } } };
  let upgraded = false, submissions = 0;
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { customer: { display_name: "测试客户", phone: "99000000001", mfa_configured: true }, totalMinor: 200000, accounts: [account], cards: [], transactions: [], subscriptions: [], ai: { configured: true }, statement: { month: "2026-10", expenseMinor: 0, categories: [] } } }));
  await page.route(`**/api/v1/operations/${draft.operationId}`, route => route.fulfill({ json: { ...draft, riskLevel: upgraded ? "RED" : "YELLOW", requiredAuth: upgraded ? "MFA" : "CONFIRM" } }));
  await page.route(`**/api/v1/operations/${draft.operationId}/authorize`, route => {
    submissions++;
    if (!upgraded) {
      expect(route.request().postDataJSON()).not.toHaveProperty("totpCode");
      upgraded = true;
      return route.fulfill({ status: 409, json: { error: "AUTH_REQUIRED", message: "资金未转出，请完成强验证。" } });
    }
    expect(route.request().postDataJSON()).toMatchObject({ totpCode: "123456" });
    return route.fulfill({ json: { status: "SUCCEEDED" } });
  });
  await page.goto(`/?authorize=${draft.operationId}`);
  const dialog = page.getByRole("dialog", { name: "核对转账" });
  await expect(dialog).toContainText("黄色风险");
  await dialog.getByRole("button", { name: "确认转账" }).click();
  await expect(dialog).toContainText("红色风险");
  await expect(dialog.getByRole("alert")).toContainText("资金未转出");
  await expect(dialog.getByRole("button", { name: "确认转账" })).toBeDisabled();
  expect(submissions).toBe(1);
  await dialog.getByPlaceholder("6 位动态验证码").fill("123456");
  await dialog.getByRole("button", { name: "确认转账" }).click();
  await expect(page.getByRole("status")).toContainText("转账已完成");
  expect(submissions).toBe(2);
});

for (const refreshStatus of [401, 404]) {
  test(`an upgrade followed by a ${refreshStatus} refresh blocks the stale confirmation`, async ({ page }) => {
    const account = { id: "00000000-0000-4000-8000-000000000001", name: "活期账户", masked_no: "•• 1001", account_type: "CHECKING", available_balance_minor: "200000", currency: "CNY", status: "ACTIVE" };
    const draft = { operationId: "TRF-UI-REFRESH", status: "AWAITING_AUTH", riskLevel: "YELLOW", requiredAuth: "CONFIRM", details: { amountMinor: 60000, sourceAccount: account, recipient: { name: "收款测试用户", phoneMasked: "990****0002", maskedAccount: "•• 1002" } } };
    let submissions = 0;
    await page.route("**/api/bootstrap", route => route.fulfill({ json: { customer: { display_name: "测试客户", phone: "99000000001", mfa_configured: true }, totalMinor: 200000, accounts: [account], cards: [], transactions: [], ai: { configured: true }, statement: { month: "2026-10", expenseMinor: 0, categories: [] } } }));
    await page.route(`**/api/v1/operations/${draft.operationId}`, route => route.fulfill(submissions
      ? { status: refreshStatus, json: { error: "OPERATION_UNAVAILABLE", message: "无法读取操作" } }
      : { json: draft }));
    await page.route(`**/api/v1/operations/${draft.operationId}/authorize`, route => {
      submissions++;
      return route.fulfill({ status: 409, json: { error: "AUTH_REQUIRED", message: "资金未转出，请完成强验证。" } });
    });
    await page.goto(`/?authorize=${draft.operationId}`);
    const dialog = page.getByRole("dialog", { name: "核对转账" });
    await expect(dialog).toContainText("黄色风险");
    await dialog.getByRole("button", { name: "确认转账" }).click();
    await expect(dialog.getByRole("alert")).toContainText("无法读取最新授权状态");
    await expect(dialog.getByRole("button", { name: "确认转账" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "重新读取账户状态" })).toBeVisible();
    expect(submissions).toBe(1);
  });
}

test("real API pre-created 600 CNY drafts cannot cross the daily limit through the APP", async ({ page, baseURL }) => {
  test.skip(process.env.BANKPILOT_DEMO_E2E !== "1", "Requires the disposable database demo server");
  await page.goto("/");
  await page.getByRole("button", { name: "以小土豆进入" }).click();
  await expect(page.getByRole("button", { name: "AI 助手", exact: true })).toBeVisible();
  const before = await (await page.request.get("/api/bootstrap")).json();
  const headers = { origin: baseURL! };
  const drafts: Array<{ operationId: string; riskLevel: string }> = [];
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post("/api/v1/transfers/prepare", { headers, data: { fromAccountId: before.accounts[0].id, recipient: "小板栗", amountMinor: 60000 } });
    expect(response.status()).toBe(201);
    const draft = await response.json();
    expect(draft.riskLevel).toBe("YELLOW"); drafts.push(draft);
  }
  expect((await page.request.post(`/api/v1/operations/${drafts[0].operationId}/authorize`, { headers, data: {} })).status()).toBe(200);
  await page.goto(`/?authorize=${drafts[1].operationId}`);
  const dialog = page.getByRole("dialog", { name: "核对转账" });
  await expect(dialog).toContainText("黄色风险");
  const response = page.waitForResponse(value => value.url().endsWith(`/operations/${drafts[1].operationId}/authorize`) && value.request().method() === "POST");
  await dialog.getByRole("button", { name: "确认转账" }).click();
  expect((await response).status()).toBe(409);
  await expect(dialog).toContainText("红色风险");
  await expect(dialog).toContainText("需要先启用多因素认证");
  await expect(dialog.getByRole("button", { name: "确认转账" })).toBeDisabled();
  const state = await (await page.request.get(`/api/v1/operations/${drafts[1].operationId}`)).json();
  expect(state).toMatchObject({ status: "AWAITING_AUTH", riskLevel: "RED", requiredAuth: "MFA" });
  const after = await (await page.request.get("/api/bootstrap")).json();
  expect(after.totalMinor).toBe(before.totalMinor - 60000);
  expect(after.transactions).toHaveLength(before.transactions.length + 1);
});
