import { test, expect, type Page } from "@playwright/test";
import type { AppAgentView, AppPage, PageAction } from "../src/lib/app-agent-protocol";

const cardId = "00000000-0000-4000-8000-000000000001";
const bootstrap = {
  customer: { display_name: "测试客户", phone: "13800000000", mfa_configured: true }, totalMinor: 500000,
  accounts: [{ id: "test-account", name: "活期", account_no: "private-account", masked_no: "•••• 1234", account_type: "CHECKING", available_balance_minor: "500000", currency: "CNY", status: "ACTIVE" }],
  transactions: [], subscriptions: [],
  cards: [{ id: cardId, card_name: "日常卡", masked_no: "•••• 5678", card_type: "VIRTUAL", status: "ACTIVE", daily_limit_minor: "100000" }],
  statement: { month: "2026-10", expenseMinor: 0, incomeMinor: 0, transactionCount: 0, anomalyCount: 0, categories: [], anomalies: [] },
  ai: { configured: true, model: "browser-test-transport" },
};

async function setup(page: Page, scenario: "card" | "pause" | "choices") {
  const calls: Array<Record<string, unknown>> = [];
  let sequence = 0;
  let bankWrites = 0;
  let run: AppAgentView;
  const pending = (action: PageAction, status: AppAgentView["status"]) => {
    run = { ...run, status, pending: { id: `action-${++sequence}`, action }, message: action.type === "question" ? action.question : action.description, steps: sequence };
  };
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: bootstrap }));
  await page.route("**/api/v1/cards/**/lock", (route) => { bankWrites++; return route.fulfill({ json: { status: "LOCKED" } }); });
  await page.route("**/api/agent/app", async (route) => {
    const input = route.request().postDataJSON();
    calls.push(input);
    const snapshot: AppPage = input.page ?? input.result?.page;
    if (input.command === "start") {
      run = { id: "00000000-0000-4000-8000-000000000002", status: "RUNNING", pending: null, controlGranted: false, message: "", steps: 0 };
      if (scenario === "choices") pending({ type: "question", question: "你想查看哪张卡？", options: ["日常卡", "旅行卡"] }, "QUESTION");
      else pending({ type: "click", target: "nav-cards", pageVersion: snapshot.version, description: "打开卡片管理" }, "CONSENT");
    } else if (input.command === "allow") run = { ...run, controlGranted: true, status: "ACTION" };
    else if (input.command === "pause") run = { ...run, status: "PAUSED" };
    else if (input.command === "cancel") run = { ...run, status: "CANCELLED", pending: null, controlGranted: false };
    else if (input.command === "refresh") pending({ type: "click", target: "nav-cards", pageVersion: snapshot.version, description: "重新打开卡片管理" }, "ACTION");
    else if (scenario === "choices") pending({ type: "click", target: "nav-cards", pageVersion: snapshot.version, description: "打开选定卡片" }, "CONSENT");
    else if (sequence === 1 && scenario === "card") pending({ type: "click", target: `view-card-${cardId}`, pageVersion: snapshot.version, description: "查看日常卡" }, "ACTION");
    else if (scenario === "card" && sequence === 2) {
      // Even a hostile or mistaken model cannot click final bank confirmation.
      pending({ type: "click", target: "confirm-card-lock", pageVersion: snapshot.version, description: "尝试点击确认" }, "ACTION");
    } else pending({ type: "handoff", description: "请你本人确认锁卡" }, "HANDOFF");
    await route.fulfill({ json: run });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  await page.getByRole("textbox", { name: "向 AI 助手描述需求或回答问题" }).fill("查看我的卡片");
  await page.getByRole("button", { name: "发送给 AI 助手" }).click();
  return { calls, bankWrites: () => bankWrites };
}

test("visible clicks navigate real React pages, but bank confirmation remains human", async ({ page }) => {
  const state = await setup(page, "card");
  await expect(page.getByRole("button", { name: "允许代操作" })).toBeVisible();
  expect(state.calls[0].page).toMatchObject({ name: "首页" });
  await page.getByRole("button", { name: "允许代操作" }).click();
  await expect(page.getByRole("heading", { name: "我的卡" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认锁定这张卡" })).toBeVisible();
  await expect.poll(() => state.calls.filter((call) => call.command === "advance").length).toBe(3);
  expect(state.calls.at(-1)?.result).toMatchObject({ status: "BLOCKED", message: "USER_REQUIRED" });
  expect(state.bankWrites()).toBe(0);
  await page.getByRole("button", { name: "确认锁定这张卡" }).click();
  await expect.poll(state.bankWrites).toBe(1);
});

test("a trusted user touch cancels the highlighted click; continue observes the new page", async ({ page }) => {
  const state = await setup(page, "pause");
  await page.getByRole("button", { name: "允许代操作" }).click();
  await expect(page.locator('[data-agent-id="nav-cards"][data-agent-highlight]')).toBeVisible();
  await page.getByRole("button", { name: "隐藏余额", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 AI 助手会话" })).toContainText("已暂停");
  await page.waitForTimeout(650); // Longer than the visible action highlight; the queued click must not run.
  await expect(page.getByRole("heading", { name: "我的卡" })).toHaveCount(0);
  expect(state.calls.filter((call) => call.command === "advance")).toHaveLength(0);
  await page.getByRole("button", { name: "继续代操作" }).click();
  await expect.poll(() => state.calls.some((call) => call.command === "refresh")).toBe(true);
  expect(state.calls.find((call) => call.command === "refresh")?.result).toMatchObject({ status: "USER_CHANGED", page: { name: "首页" } });
  await expect(page.getByRole("heading", { name: "我的卡" })).toBeVisible();
});

test("choice buttons and free text clarify intent without granting page control", async ({ page }) => {
  const state = await setup(page, "choices");
  await expect(page.getByRole("button", { name: "日常卡", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "旅行卡", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "向 AI 助手描述需求或回答问题" }).fill("都不是，是工资卡");
  await page.getByRole("button", { name: "发送给 AI 助手" }).click();
  await expect(page.getByRole("button", { name: "允许代操作" })).toBeVisible();
  expect(state.calls.at(-1)?.result).toMatchObject({ status: "USER_ANSWERED", message: "都不是，是工资卡" });
  expect(state.calls.some((call) => call.command === "allow")).toBe(false);
  await expect(page.getByRole("heading", { name: "我的卡" })).toHaveCount(0);
});
