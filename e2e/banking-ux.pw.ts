import { expect, test } from "@playwright/test";

const cardId = "00000000-0000-4000-8000-000000000001";
const overview = {
  customer: { display_name: "测试客户", phone: "99000000001", demo: true, mfa_configured: false }, totalMinor: 500000,
  accounts: [{ id: "00000000-0000-4000-8000-000000000002", name: "活期账户", masked_no: "•• 1234", account_no: "test-only", currency: "CNY", status: "ACTIVE" }],
  cards: [{ id: cardId, card_name: "日常卡", masked_no: "•••• 5678", card_type: "VIRTUAL", status: "ACTIVE", daily_limit_minor: "100000" }],
  transactions: [], subscriptions: [], ai: { configured: true, model: "test-transport" },
  statement: { month: "2026-10", expenseMinor: 0, categories: [], transactionCount: 0 },
};

test("all assistant entry points preserve one conversation and reflect navigation state", async ({ page }) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/agent/app", route => route.fulfill({ json: { id: cardId, status: "QUESTION", controlGranted: false, steps: 1, message: "请选择一张卡", pending: { id: "q1", action: { type: "question", question: "请选择一张卡", options: ["日常卡"] } } } }));
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "AI 助手" }).click();
  await expect(nav.getByRole("button", { name: "AI 助手" })).toHaveAttribute("aria-current", "page");
  const conversation = await page.getByRole("region", { name: "AI 助手会话" }).boundingBox();
  const canvas = await page.locator('[data-pointer="canvas"]').boundingBox();
  const navigation = await nav.boundingBox();
  expect(conversation && canvas && navigation).toBeTruthy();
  expect(conversation!.x).toBeCloseTo(canvas!.x, 0);
  expect(conversation!.y).toBeCloseTo(canvas!.y, 0);
  expect(conversation!.width).toBeCloseTo(canvas!.width, 0);
  expect(conversation!.height).toBeCloseTo(navigation!.y - canvas!.y, 0);
  await page.getByRole("textbox", { name: "向 AI 助手描述需求或回答问题" }).fill("查看我的卡");
  await page.getByRole("button", { name: "发送给 AI 助手" }).click();
  await expect(page.getByRole("region", { name: "AI 助手会话" })).toContainText("请选择一张卡");
  await nav.getByRole("button", { name: "卡片", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI 助手会话" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "卡片", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "查看 AI 助手会话" }).click();
  await expect(page.getByRole("region", { name: "AI 助手会话" })).toContainText("查看我的卡");
  await expect(nav.getByRole("button", { name: "AI 助手" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "返回银行页面" }).click();
  await nav.getByRole("button", { name: "首页", exact: true }).click();
  await nav.getByRole("button", { name: "AI 助手", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI 助手会话" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "AI 助手会话" })).toContainText("查看我的卡");
});

test("locking a card requires the bank dialog and submits once while confirmation is busy", async ({ page }) => {
  let calls = 0, nativeDialogs = 0;
  let finish!: () => void;
  let locked = false;
  page.on("dialog", dialog => { nativeDialogs++; void dialog.dismiss(); });
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { ...overview, cards: [{ ...overview.cards[0], status: locked ? "LOCKED" : "ACTIVE" }] } }));
  await page.route("**/api/v1/cards/*/lock", async route => { calls++; await new Promise<void>(resolve => { finish = resolve; }); locked = true; await route.fulfill({ json: { status: "LOCKED" } }); });
  await page.goto("/");
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(`[data-agent-id="view-card-${cardId}"]`).click();
  await expect(page.getByRole("dialog", { name: "卡片管理" })).toBeVisible();
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(calls).toBe(0);
  await page.locator(`[data-agent-id="view-card-${cardId}"]`).click();
  await page.getByRole("button", { name: "确认锁定这张卡" }).click({ clickCount: 2 });
  await expect.poll(() => calls).toBe(1);
  await expect(page.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "卡片管理" })).toBeVisible();
  finish();
  await expect(page.getByRole("dialog", { name: "卡片管理" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("卡片已锁定");
  expect(calls).toBe(1); expect(nativeDialogs).toBe(0);
});

test("a lost write response cannot claim failure or allow repeated confirmation", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/cards/*/lock", route => { writes++; return route.abort("connectionreset"); });
  await page.goto("/");
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(`[data-agent-id="view-card-${cardId}"]`).click();
  await page.getByRole("button", { name: "确认锁定这张卡" }).click();
  await expect(page.getByRole("dialog", { name: "卡片管理" }).getByRole("alert")).toContainText("暂时无法确认操作结果");
  await expect(page.getByRole("button", { name: "确认锁定这张卡" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "重新读取卡片状态" })).toBeVisible();
  expect(writes).toBe(1);
});

test("an acknowledged write stays acknowledged when the subsequent account read fails", async ({ page }) => {
  let locked = false;
  await page.route("**/api/bootstrap", route => locked
    ? route.fulfill({ status: 503, json: { message: "read unavailable" } })
    : route.fulfill({ json: overview }));
  await page.route("**/api/v1/cards/*/lock", route => { locked = true; return route.fulfill({ json: { status: "LOCKED" } }); });
  await page.goto("/");
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(`[data-agent-id="view-card-${cardId}"]`).click();
  await page.getByRole("button", { name: "确认锁定这张卡" }).click();
  await expect(page.getByRole("heading", { name: "账户数据暂不可用" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("卡片已锁定");
  await expect(page.getByText("¥0.00", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认锁定这张卡" })).toHaveCount(0);
});

test("unavailable account data is distinct from a genuine zero balance", async ({ page }) => {
  let available = false;
  await page.route("**/api/bootstrap", route => available ? route.fulfill({ json: { ...overview, totalMinor: 0 } }) : route.fulfill({ status: 503, json: { message: "unavailable" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "账户数据暂不可用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "转账", exact: true })).toHaveCount(0);
  await expect(page.getByText("¥0.00", { exact: true })).toHaveCount(0);
  available = true;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.getByRole("heading", { name: "你好，测试客户" })).toBeVisible();
  await expect(page.getByText("¥0.00", { exact: true })).toHaveCount(2);
});

test("demo verifier enrollment explains the shared account and requires explicit consent", async ({ page }) => {
  let input: unknown;
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/security/totp/setup", route => { input = route.request().postDataJSON(); return route.fulfill({ json: { secret: "TESTONLYTESTONLY", uri: "otpauth://totp/test" } }); });
  await page.route("**/api/v1/security/totp/confirm", route => route.fulfill({ json: { enabled: true } }));
  await page.goto("/security");
  await expect(page.getByText("测试客户 · 共享账户")).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始设置" })).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "开始设置" }).click();
  await expect(page.getByRole("heading", { name: "添加到你的身份验证器" })).toBeVisible();
  expect(input).toEqual({ demoConfirmed: true });
  await page.getByRole("textbox", { name: "6 位动态码" }).fill("123456");
  await page.getByRole("button", { name: "确认并启用" }).click();
  await expect(page.getByRole("status")).toContainText("验证器启用成功");
  await expect(page.getByRole("button", { name: "开始设置" })).toHaveCount(0);
});

test("audit view reflects failed nodes and unavailable service health", async ({ page }) => {
  await page.route("**/api/health", route => route.fulfill({ status: 503, json: { status: "degraded", database: "unavailable" } }));
  await page.route("**/api/audit", route => route.fulfill({ json: { tasks: [{ id: cardId, user_utterance: "失败的任务", intent: "TRANSFER", status: "FAILED", risk_level: "RED", plan: [], created_at: new Date().toISOString(), nodes: [{ key: "transfer", tool: "transfer", status: "FAILED", dependencies: [], output: {} }, { key: "pending", tool: "confirm", status: "AWAITING_AUTH", dependencies: [], output: {} }, { key: "unknown", tool: "unknown", status: "UNRECOGNIZED", dependencies: [], output: {} }] }], events: [], policies: [], externalAccessHistory: [], channelEvents: [], channels: [], outbox: [] } }));
  await page.goto("/audit");
  await expect(page.getByRole("status")).toContainText("服务状态读取失败");
  await expect(page.getByText("所有系统正常")).toHaveCount(0);
  await expect(page.locator('svg[aria-label="失败"]')).toHaveCount(1);
  await expect(page.locator('svg[aria-label="等待确认"]')).toHaveCount(1);
  await expect(page.getByText("未知状态（UNRECOGNIZED）", { exact: true })).toBeVisible();
});

test("channel removal can be cancelled and an ambiguous response is checked before retry", async ({ page }) => {
  let deletes = 0;
  let status = "ACTIVE";
  await page.route("**/api/v1/channels/onboarding", route => route.fulfill({ json: { providers: [{ channelType: "QQ", name: "QQ", botName: "BankPilot", entryUrl: "https://qq.com", canStart: true, unavailableReason: null }] } }));
  await page.route("**/api/v1/channels", route => {
    if (route.request().method() === "DELETE") { deletes++; status = "REVOKED"; return route.fulfill({ status: 503, json: { message: "回执暂时不可用" } }); }
    return route.fulfill({ json: { channels: [{ id: cardId, channel_type: "QQ", status, bound_at: new Date().toISOString(), last_seen_at: null }] } });
  });
  await page.goto("/channels");
  await page.getByRole("button", { name: "解除绑定", exact: true }).click();
  await page.getByRole("button", { name: "保留绑定" }).click();
  expect(deletes).toBe(0);
  await page.getByRole("button", { name: "解除绑定", exact: true }).click();
  await page.getByRole("button", { name: "确认解除" }).click();
  await expect(page.getByRole("button", { name: "确认解除" })).toBeDisabled();
  await page.getByRole("button", { name: "重新读取绑定状态" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("已核实");
  expect(deletes).toBe(1);
});
