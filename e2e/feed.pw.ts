import { expect, test } from "@playwright/test";
import { buildFeed, type FeedPost } from "../src/lib/feed";

const overview = {
  customer: { display_name: "测试客户", phone: "99000000009", demo: true, mfa_configured: false }, totalMinor: 500000,
  accounts: [{ id: "00000000-0000-4000-8000-000000000002", name: "活期账户", masked_no: "•• 1234", account_no: "test-only", currency: "CNY", status: "ACTIVE" }],
  cards: [], transactions: [], subscriptions: [], ai: { configured: true, model: "test-transport" },
  statement: { month: "2026-10", expenseMinor: 0, categories: [], transactionCount: 0 },
};
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const drafts = buildFeed({
  transactions: [
    { id: "t1", merchant_name: "澄光数码", category: "购物", amount_minor: -399900, occurred_at: ago(1), is_anomaly: true },
    { id: "t2", merchant_name: "咖啡", category: "餐饮", amount_minor: -3200, occurred_at: ago(2), is_anomaly: false },
  ],
  subscriptions: [{ id: "s1", merchant_name: "网盘", amount_minor: 1800, next_charge_at: ago(-3), status: "ACTIVE" }],
}, now);
// 接口返回已发布的帖子：带编号与发布时间，最上面的最新。
const posts: FeedPost[] = drafts.map(({ key, ...draft }, index) => ({ ...draft, id: key, publishedAt: new Date(now.getTime() - index * 60_000).toISOString() }));

test("feed posts take a reaction and open a quoted discussion without touching the bank", async ({ page }) => {
  const writes: string[] = [];
  let started: Record<string, unknown> | undefined;
  page.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/v1/")) writes.push(request.url()); });
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  let served = posts;
  await page.route("**/api/v1/feed", route => route.fulfill({ json: { posts: served } }));
  await page.route("**/api/agent/app", async route => {
    started = route.request().postDataJSON();
    await route.fulfill({ json: { id: "00000000-0000-4000-8000-000000000003", status: "COMPLETED", pending: null, controlGranted: false, steps: 0, message: "这笔消费发生在昨天。" } });
  });
  await page.goto("/");
  const feed = page.getByRole("region", { name: "动态" });
  // 第一张是置顶的资产卡，帖子从第二张开始。
  await expect(feed.getByRole("article").first()).toHaveAccessibleName("资产");
  const anomaly = feed.getByRole("article").nth(1);
  await expect(anomaly).toContainText("这笔 ¥3,999 和你平时不太一样");
  await expect(anomaly).toContainText("需要你看看");
  await expect(feed.getByRole("article")).toHaveCount(posts.length + 1);
  await expect(anomaly.locator("time")).toHaveText(/^(刚刚|今天 \d\d:\d\d|昨天 \d\d:\d\d)$/);

  const subscriptions = feed.getByRole("article", { name: "软件订阅每月花 ¥18，一年就是 ¥216" });
  await subscriptions.getByRole("button", { name: "踩" }).click();
  await expect(subscriptions.getByRole("button", { name: "踩" })).toHaveAttribute("aria-pressed", "true");
  await expect(subscriptions).toContainText("以后少发这类");
  expect(await page.evaluate(() => localStorage.getItem("bankpilot-feed-taste:v1:99000000009"))).toContain("\"subscriptions\":-1");

  // 踩只影响以后：已经看过的那条保留，之后新发布的同类帖子不再出现。
  const later = { ...posts.find(post => post.kind === "subscriptions")!, id: "later", title: "下个月的订阅总账", publishedAt: new Date(Date.now() + 60_000).toISOString() };
  served = [later, ...posts];
  await page.reload();
  await expect(feed.getByRole("article")).toHaveCount(posts.length + 1);
  await expect(subscriptions).toBeVisible();
  await expect(feed.getByRole("article", { name: "下个月的订阅总账" })).toHaveCount(0);

  await anomaly.getByRole("button", { name: "讨论" }).click();
  const conversation = page.getByRole("region", { name: "AI 助手会话" });
  await expect(conversation.getByLabel("正在引用的动态")).toContainText("这笔 ¥3,999 和你平时不太一样");
  await conversation.getByRole("textbox", { name: "向 AI 助手描述需求或回答问题" }).fill("这是哪里的消费？");
  await conversation.getByRole("button", { name: "发送给 AI 助手" }).click();
  await expect(conversation).toContainText("这笔消费发生在昨天。");
  expect(started).toMatchObject({ command: "start" });
  expect(String(started?.message)).toMatch(/^【引用动态】这笔 ¥3,999 和你平时不太一样。[\s\S]*这是哪里的消费？$/);
  await expect(conversation.getByLabel("正在引用的动态")).toHaveCount(0);
  await expect(conversation.locator("p", { hasText: "这笔 ¥3,999 和你平时不太一样" })).toBeVisible();
  expect(writes).toEqual([]);
});
