import { expect, test } from "@playwright/test";
import type { FeedPost } from "../src/lib/feed";
import { DEFAULT_LAYOUT } from "../src/lib/ui-schema";

const overview = {
  customer: { display_name: "测试客户", phone: "99000000010", demo: true, mfa_configured: false }, totalMinor: 500000,
  accounts: [{ id: "00000000-0000-4000-8000-000000000002", name: "活期账户", masked_no: "•• 1234", account_no: "test-only", currency: "CNY", status: "ACTIVE", available_balance_minor: "500000" }],
  cards: [], transactions: [], subscriptions: [], ai: { configured: true, model: "test-transport" },
  statement: { month: "2026-10", expenseMinor: 0, categories: [], transactionCount: 0 },
};
const post = (id: string, kind: FeedPost["kind"], title: string, recipeId?: string): FeedPost => ({ id, kind, title, body: "说明", source: "测试", attention: false, factIds: [], publishedAt: new Date().toISOString(),
  chart: { type: "recipe", blocks: [] }, ...(recipeId ? { recipeId } : {}) });
const posts = [post("a", "anomaly", "这笔 ¥3,999 和你平时不太一样"), post("p", "position", "稳享 30 天持有 12 天，赚了 ¥3.35"), post("c", "custom", "本周咖啡 ¥70", "coffee"), post("f", "friends", "近两个月，你净转给小板栗 ¥897")];
const pageId = "00000000-0000-4000-8000-0000000000a1";
const proposalId = "00000000-0000-4000-8000-0000000000b1";

test("a layout proposal previews in chat, only the user's click applies it, and then home and nav follow it", async ({ page }) => {
  let applied = false;
  const decisions: unknown[] = [];
  const layout = { home: [{ type: "feed", kinds: ["position"], limit: 2, latestPerKind: false }, { type: "feed", recipeIds: ["coffee"], limit: 1, latestPerKind: false }, { type: "assets" }],
    nav: [{ type: "system", id: "home" }, { type: "page", pageId }, { type: "system", id: "blank" }, { type: "system", id: "activity" }, { type: "system", id: "cards" }] };
  const view = () => ({ proposal: { id: proposalId, kind: "layout", status: applied ? "APPLIED" : "PENDING", summary: "首页只留理财和咖啡，资产放最下面，底栏加上咖啡专题",
    layout: { home: [{ label: "理财走势", detail: "最多 2 条" }, { label: "咖啡周报", detail: "最多 1 条" }, { label: "资产", detail: "总资产和活期、理财构成" }],
      nav: [{ label: "首页", icon: "system", isPage: false }, { label: "咖啡专题", icon: "coffee", isPage: true }, { label: "Blank", icon: "system", isPage: false }], changedHome: true, changedNav: true } } });
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/feed", route => route.fulfill({ json: { posts } }));
  await page.route("**/api/v1/ui", route => route.fulfill({ json: applied ? { layout, pages: [{ id: pageId, name: "咖啡专题", icon: "coffee" }] } : { layout: DEFAULT_LAYOUT, pages: [] } }));
  await page.route(`**/api/v1/ui/proposals/${proposalId}`, async route => {
    if (route.request().method() === "POST") { decisions.push(route.request().postDataJSON()); applied = true; return route.fulfill({ json: { status: "APPLIED" } }); }
    await route.fulfill({ json: view() });
  });
  await page.route("**/api/agent/app", route => route.fulfill({ json: { id: "00000000-0000-4000-8000-0000000000c1", status: "COMPLETED", pending: null, controlGranted: false, steps: 2,
    message: `改好了方案，你看看：\n\n[[proposal:${proposalId}]]\n\n点卡片上的“应用”才会生效。` } }));
  await page.goto("/");
  // 默认首页：资产卡 + 全部动态，底栏是系统五项。
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(page.getByRole("article", { name: "这笔 ¥3,999 和你平时不太一样" })).toBeVisible();
  await expect(nav.getByRole("button")).toHaveCount(5);
  await nav.getByRole("button", { name: "Blank" }).click();
  const conversation = page.getByRole("region", { name: "Blank 会话" });
  await conversation.getByRole("textbox", { name: "向 Blank 描述需求或回答问题" }).fill("首页只留理财和咖啡卡片，资产放最下面，咖啡放进底栏");
  await conversation.getByRole("button", { name: "发送给 Blank" }).click();
  const card = conversation.getByRole("article", { name: /界面方案：/ });
  await expect(card).toContainText("理财走势");
  await expect(card).toContainText("咖啡专题");
  await expect(card).toContainText("点“应用”才会生效");
  await expect(conversation).not.toContainText("[[proposal:");
  expect(decisions).toEqual([]); // 说了不算，点了才算
  await card.getByRole("button", { name: "应用到我的 Blank" }).click();
  await expect(card).toContainText("已应用");
  expect(decisions).toEqual([{ action: "apply" }]);
  // 回到首页：只剩理财和咖啡，其余动态隐藏；底栏多了咖啡专题。
  // 开发模式的角标会盖住最左边的导航项，直接派发点击事件。
  await nav.getByRole("button", { name: "首页" }).dispatchEvent("click");
  await expect(page.getByRole("article", { name: "稳享 30 天持有 12 天，赚了 ¥3.35" })).toBeVisible();
  await expect(page.getByRole("article", { name: "本周咖啡 ¥70" })).toBeVisible();
  await expect(page.getByRole("article", { name: "这笔 ¥3,999 和你平时不太一样" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "近两个月，你净转给小板栗 ¥897" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "资产" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "咖啡专题" })).toBeVisible();
  // 资产放在最后。
  const order = await page.locator("section[aria-label='动态'] article").evaluateAll(items => items.map(item => item.getAttribute("aria-label")));
  expect(order.at(-1)).toBe("资产");
});

test("a custom page opens from the nav with its panels laid out by the grammar", async ({ page }) => {
  const layout = { ...DEFAULT_LAYOUT, nav: [{ type: "system", id: "home" }, { type: "page", pageId }, { type: "system", id: "blank" }, { type: "system", id: "activity" }, { type: "system", id: "cards" }] };
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/feed", route => route.fulfill({ json: { posts } }));
  await page.route("**/api/v1/ui", route => route.fulfill({ json: { layout, pages: [{ id: pageId, name: "咖啡专题", icon: "coffee" }] } }));
  await page.route(`**/api/v1/ui/pages/${pageId}`, route => route.fulfill({ json: { page: { id: pageId, name: "咖啡专题", icon: "coffee", panels: [
    { title: "合计", width: "half", blocks: [{ type: "stat", label: "合计", text: "¥60" }] },
    { title: "笔数", width: "half", blocks: [{ type: "stat", label: "笔数", text: "2 笔" }] },
    { title: "最近几笔", width: "full", blocks: [{ type: "list", items: [{ label: "漫拿咖啡", note: "10/28", minor: 3200 }, { label: "星杯咖啡", note: "10/27", minor: 2800 }] }] },
  ] } } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "咖啡专题" }).click();
  await expect(page.getByRole("heading", { name: "咖啡专题", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "咖啡专题" })).toHaveAttribute("aria-current", "page");
  const half = await Promise.all(["合计", "笔数"].map(title => page.getByRole("region", { name: title }).boundingBox()));
  const full = await page.getByRole("region", { name: "最近几笔" }).boundingBox();
  expect(half[0] && half[1] && full).toBeTruthy();
  expect(Math.abs(half[0]!.y - half[1]!.y)).toBeLessThan(2); // 半宽并排
  expect(half[1]!.x).toBeGreaterThan(half[0]!.x + half[0]!.width - 2);
  expect(full!.width).toBeGreaterThan(half[0]!.width * 1.8); // 整行
  await expect(page.getByText("漫拿咖啡")).toBeVisible();
  // 回首页仍是默认布局。
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "首页" }).dispatchEvent("click");
  await expect(page.getByRole("article", { name: "这笔 ¥3,999 和你平时不太一样" })).toBeVisible();
});
