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
  const conversation = page.getByRole("region", { name: "Blank 会话" });
  await expect(conversation.getByLabel("正在引用的动态")).toContainText("这笔 ¥3,999 和你平时不太一样");
  await conversation.getByRole("textbox", { name: "向 Blank 描述需求或回答问题" }).fill("这是哪里的消费？");
  await conversation.getByRole("button", { name: "发送给 Blank" }).click();
  await expect(conversation).toContainText("这笔消费发生在昨天。");
  expect(started).toMatchObject({ command: "start" });
  expect(String(started?.message)).toMatch(/^【引用动态】这笔 ¥3,999 和你平时不太一样。[\s\S]*这是哪里的消费？$/);
  await expect(conversation.getByLabel("正在引用的动态")).toHaveCount(0);
  await expect(conversation.locator("p", { hasText: "这笔 ¥3,999 和你平时不太一样" })).toBeVisible();
  expect(writes).toEqual([]);
});

test("a card designed in chat renders as a live preview, then shows as added", async ({ page }) => {
  const cardId = "00000000-0000-4000-8000-0000000000c1";
  let status: "DRAFT" | "ACTIVE" = "DRAFT";
  const preview: FeedPost = { id: cardId, recipeId: cardId, kind: "custom", title: "本周咖啡花了 ¥90，比上周同期多 50%", source: "咖啡周报", attention: false,
    body: "你创建的「咖啡周报」，每周一 8 点更新。", publishedAt: new Date().toISOString(), factIds: [],
    chart: { type: "recipe", blocks: [{ type: "stat", label: "笔数", text: "3 笔" }, { type: "bars", items: [{ label: "漫拿咖啡", minor: 6200, note: "2 笔" }] },
      { type: "line", baselineMinor: 3000, baselineLabel: "每天平均", points: [{ date: "2026-10-26", minor: 3200 }, { date: "2026-10-27", minor: 2800 }, { date: "2026-10-28", minor: 3000 }] }] } };
  const replies = [`好的，先给你看看这张卡：\n\n[[card:${cardId}]]\n\n每周一早上 8 点更新，要加入动态吗？`, `已经加到你的动态里了。\n\n[[card:${cardId}]]`];
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/feed", route => route.fulfill({ json: { posts } }));
  await page.route(`**/api/v1/feed/recipes/${cardId}`, route => route.fulfill({ json: { status, post: preview } }));
  await page.route("**/api/agent/app", async route => {
    const message = replies.shift()!;
    if (!replies.length) status = "ACTIVE";
    // 用户说“好”是一次新的对话运行，编号不同。
    await route.fulfill({ json: { id: `00000000-0000-4000-8000-00000000000${replies.length + 4}`, status: "COMPLETED", pending: null, controlGranted: false, steps: 0, message } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Blank" }).click();
  const conversation = page.getByRole("region", { name: "Blank 会话" });
  const input = conversation.getByRole("textbox", { name: "向 Blank 描述需求或回答问题" });
  await input.fill("每周一帮我做张卡，看看咖啡花了多少");
  await conversation.getByRole("button", { name: "发送给 Blank" }).click();
  const card = conversation.getByRole("article", { name: `卡片预览：${preview.title}` });
  await expect(card).toContainText("3 笔");
  await expect(card).toContainText("漫拿咖啡");
  await expect(card).toContainText("选“加入动态”后生效");
  // 预览卡不在首页容器里，图表颜色仍必须来自校验过的色板（曾经因为变量只定义在首页容器而回退成黑色）。
  const stroke = await card.locator("svg[role='img'] path").last().evaluate(path => getComputedStyle(path).stroke);
  expect(stroke).toBe("rgb(47, 125, 50)");
  await expect(conversation).not.toContainText("[[card:");
  await input.fill("好");
  await conversation.getByRole("button", { name: "发送给 Blank" }).click();
  await expect(conversation.getByText("已加入你的动态")).toBeVisible();
});

test("a scheduled task designed in chat renders as a preview, takes effect only after the answer, and stays out of the manual form", async ({ page }) => {
  const taskId = "00000000-0000-4000-8000-0000000000d1";
  let status: "DRAFT" | "ACTIVE" = "DRAFT";
  const card = () => ({ id: taskId, status, title: "还信用卡", kind: "提醒", rhythm: "每月 5 号 09:00", nextRun: "11/5 周四 09:00", message: "记得还信用卡",
    sample: "还信用卡：记得还信用卡", delivery: "结果发到你的动态里，也可以在「定时任务」页查看" });
  const question = `[[schedule:${taskId}]] 每月 5 号早上 9 点提醒你还信用卡，要创建吗？`;
  // 服务端会把提问文字放进 message，对话就是从它渲染出预览卡片的。
  const run = { id: "00000000-0000-4000-8000-0000000000d2", status: "QUESTION", controlGranted: false, steps: 1, message: question, pending: { id: "q-task",
    action: { type: "question", question, options: ["创建任务", "再改改", "算了"] } } };
  const commands: string[] = [];
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/feed", route => route.fulfill({ json: { posts } }));
  await page.route(`**/api/v1/schedules/drafts/${taskId}`, route => route.fulfill({ json: { card: card() } }));
  await page.route("**/api/agent/app", async route => {
    const body = route.request().postDataJSON();
    commands.push(body.command);
    if (body.command === "start") return route.fulfill({ json: run });
    status = "ACTIVE";
    await route.fulfill({ json: { id: run.id, status: "COMPLETED", pending: null, controlGranted: false, steps: 2, message: "已经创建了，每月 5 号 9 点提醒你。" } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Blank" }).click();
  const conversation = page.getByRole("region", { name: "Blank 会话" });
  await conversation.getByRole("textbox", { name: "向 Blank 描述需求或回答问题" }).fill("每月 5 号早上 9 点提醒我还信用卡");
  await conversation.getByRole("button", { name: "发送给 Blank" }).click();
  const preview = conversation.getByRole("article", { name: "任务预览：还信用卡" });
  await expect(preview).toContainText("每月 5 号 09:00");
  await expect(preview).toContainText("11/5 周四 09:00");
  await expect(preview).toContainText("预览 · 选“创建任务”后生效");
  await expect(conversation).not.toContainText("[[schedule:");
  expect(commands).toEqual(["start"]);
  await conversation.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(conversation.getByText("已经创建了，每月 5 号 9 点提醒你。")).toBeVisible();
  expect(commands).toEqual(["start", "advance"]);
});
