import { describe, expect, it } from "vitest";
import { buildFeed, publishedLabel, yuan, type FeedTransaction } from "./feed";

const now = new Date("2026-10-28T04:00:00Z"); // 北京时间周三中午
const saturday = new Date("2026-10-31T04:00:00Z"); // 周报类帖子到周六都已发出
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
let seq = 0;
const tx = (days: number, amount: number, category = "餐饮", merchant = "店", anomaly = false): FeedTransaction =>
  ({ id: `t${++seq}`, merchant_name: merchant, category, amount_minor: amount, occurred_at: daysAgo(days), is_anomaly: anomaly });

describe("feed", () => {
  it("formats whole and fractional yuan", () => {
    expect(yuan(-399900)).toBe("¥3,999");
    expect(yuan(1850)).toBe("¥18.50");
  });

  it("builds a five-week calendar from spending only, ending in the current week", () => {
    const transactions = [1, 2, 3, 4, 5, 6].map(day => tx(day, -3000)).concat(tx(2, -40000), tx(3, -90000, "转账", "转账给小板栗"), tx(4, 1250000, "工资"));
    const post = buildFeed({ transactions, subscriptions: [] }, now).find(item => item.kind === "spending-calendar")!;
    expect(post.chart.type).toBe("calendar");
    if (post.chart.type !== "calendar") return;
    expect(post.chart.days).toHaveLength(35);
    expect(post.chart.days[0].date).toBe("2026-09-28"); // 周一
    expect(post.chart.days.reduce((sum, day) => sum + day.minor, 0)).toBe(6 * 3000 + 40000);
    expect(post.title).toContain("¥430");
  });

  it("leaves flagged spending out of the calendar headline but keeps it on the calendar", () => {
    const transactions = [1, 2, 3, 4, 5, 6].map(day => tx(day, -3000)).concat(tx(2, -399900, "购物", "澄光数码", true));
    const post = buildFeed({ transactions, subscriptions: [] }, now).find(item => item.kind === "spending-calendar")!;
    if (post.chart.type !== "calendar") throw new Error("calendar expected");
    expect(post.title).not.toContain("¥3,999");
    expect(post.title).toBe("近 5 周，你有 25 天一分钱没花");
    expect(Math.max(...post.chart.days.map(day => day.minor))).toBe(402900);
    expect(post.chart.days.filter(day => day.future)).toHaveLength(4); // 周四到周日
  });

  it("skips posts without enough facts", () => {
    expect(buildFeed({ transactions: [tx(1, -100)], subscriptions: [] }, now).map(post => post.kind)).toEqual(["money-flow"]);
    expect(buildFeed({ transactions: [], subscriptions: [] }, now)).toEqual([]);
  });

  it("folds money flow into four categories plus other and keeps the totals", () => {
    const transactions = ["购物", "餐饮", "交通", "订阅", "娱乐", "医疗"].map((category, index) => tx(index + 1, -(index + 1) * 1000, category)).concat(tx(1, 500000, "工资"));
    const post = buildFeed({ transactions, subscriptions: [] }, now).find(item => item.kind === "money-flow")!;
    if (post.chart.type !== "flow") throw new Error("flow chart expected");
    expect(post.chart.parts.map(part => part.label)).toEqual(["医疗", "娱乐", "订阅", "交通", "其他"]);
    expect(post.chart.parts.reduce((sum, part) => sum + part.minor, 0)).toBe(post.chart.outMinor);
    expect(post.chart.inMinor).toBe(500000);
  });

  it("puts a recent anomaly first and cites only that transaction", () => {
    const flagged = tx(2, -399900, "购物", "澄光数码", true);
    const posts = buildFeed({ transactions: [tx(1, -3000), tx(3, -5000), flagged], subscriptions: [] }, now);
    expect(posts[0]).toMatchObject({ kind: "anomaly", attention: true, factIds: [flagged.id] });
    expect(posts[0].title).toContain("¥3,999");
    expect(buildFeed({ transactions: [tx(20, -399900, "购物", "旧", true)], subscriptions: [] }, now).some(post => post.kind === "anomaly")).toBe(false);
  });

  it("nets transfers per friend in both directions", () => {
    const transactions = [tx(5, -8800, "转账", "转账给小板栗"), tx(4, 3000, "转账", "来自小板栗的转账"), tx(3, 20000, "转账", "来自小橘子的转账")];
    const post = buildFeed({ transactions, subscriptions: [] }, saturday).find(item => item.kind === "friends")!;
    if (post.chart.type !== "diverging") throw new Error("diverging chart expected");
    expect(post.chart.items).toEqual([{ label: "小橘子", netMinor: 20000 }, { label: "小板栗", netMinor: -5800 }]);
    expect(post.title).toBe("近两个月，小橘子净转给你 ¥200");
  });

  it("counts down the next charge on a 30-day timeline and sums subscriptions once a month", () => {
    const subscriptions = [
      { id: "s1", merchant_name: "网盘", amount_minor: 1800, next_charge_at: daysAgo(-3), status: "ACTIVE" },
      { id: "s2", merchant_name: "音乐", amount_minor: 1500, next_charge_at: daysAgo(-10), status: "ACTIVE" },
      { id: "s3", merchant_name: "已退订", amount_minor: 9900, next_charge_at: daysAgo(-1), status: "CANCELLED" },
    ];
    const [due, monthly] = buildFeed({ transactions: [], subscriptions }, now);
    expect(due).toMatchObject({ kind: "subscription-due", key: "subscription-due:s1:2026-10-31", title: "3 天后，网盘要扣 ¥18", factIds: ["s1"] });
    if (due.chart.type !== "timeline") throw new Error("timeline expected");
    expect(due.chart).toMatchObject({ start: "2026-10-28", days: 30 });
    expect(due.chart.items).toEqual([
      { label: "网盘", date: "2026-10-31", minor: 1800, highlight: true },
      { label: "音乐", date: "2026-11-07", minor: 1500 },
    ]);
    expect(monthly).toMatchObject({ kind: "subscriptions", key: "subscriptions:2026-10", title: "软件订阅每月花 ¥33，一年就是 ¥396", factIds: ["s1", "s2"] });
  });

  it("skips the countdown when no charge is within a week", () => {
    const subscriptions = [{ id: "s2", merchant_name: "音乐", amount_minor: 1500, next_charge_at: daysAgo(-10), status: "ACTIVE" }];
    expect(buildFeed({ transactions: [], subscriptions }, now).map(post => post.kind)).toEqual(["subscriptions"]);
  });

  it("charts the largest holding since purchase and counts down its unlock", () => {
    const history = Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, valueMinor: 100000 + index * 10 }));
    const locked = { id: "p1", productName: "定享 90 天", costMinor: 100000, valueMinor: 100250, profitMinor: 250, purchasedOn: "2026-10-06",
      unlocksOn: "2026-11-03", redeemable: false, businessDate: "2026-10-31", history };
    const small = { ...locked, id: "p2", productName: "零钱灵活", valueMinor: 5000, redeemable: true };
    const posts = buildFeed({ transactions: [], subscriptions: [], positions: [small, locked] }, saturday);
    const unlock = posts.find(post => post.kind === "unlock")!;
    expect(unlock).toMatchObject({ key: "unlock:p1", title: "定享 90 天还有 3 天可以赎回", chart: { type: "countdown", days: 3 } });
    const position = posts.find(post => post.kind === "position")!;
    expect(position.title).toBe("定享 90 天持有 25 天，赚了 ¥2.50");
    if (position.chart.type !== "line") throw new Error("line expected");
    expect(position.chart.points[0]).toEqual({ date: "2026-10-06", minor: 100050 });
    expect(position.chart.baselineMinor).toBe(100000);
    expect(position.body).toContain("你一共有 2 笔持仓");
  });

  it("uses stable weekly keys so a week's posts publish once", () => {
    const transactions = [1, 2, 3, 4, 5, 6].map(day => tx(day, -3000));
    const keys = (at: Date) => buildFeed({ transactions, subscriptions: [] }, at).map(post => post.key);
    expect(keys(now)).toEqual(keys(new Date("2026-10-29T04:00:00Z")));
    expect(keys(now)).toContain("spending-calendar:2026-10-26");
  });

  it("spreads weekly posts over the week: calendar Monday, flow Wednesday, holdings Thursday, friends Saturday", () => {
    const transactions = [1, 2, 3, 4, 5, 6].map(day => tx(day, -3000)).concat(tx(2, -8800, "转账", "转账给小板栗"));
    const history = Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, valueMinor: 100000 + index }));
    const positions = [{ id: "p1", productName: "稳享 30 天", costMinor: 100000, valueMinor: 100030, profitMinor: 30, purchasedOn: "2026-10-01", unlocksOn: "2026-12-01", redeemable: false, businessDate: "2026-10-31", history }];
    const weekly = (at: string) => buildFeed({ transactions, subscriptions: [], positions }, new Date(at)).map(post => post.kind).filter(kind => kind !== "anomaly");
    expect(weekly("2026-10-26T04:00:00Z")).toEqual(["spending-calendar"]);
    expect(weekly("2026-10-28T04:00:00Z")).toEqual(["spending-calendar", "money-flow"]);
    expect(weekly("2026-10-29T04:00:00Z")).toEqual(["spending-calendar", "money-flow", "position"]);
    expect(weekly("2026-10-31T04:00:00Z")).toEqual(["spending-calendar", "money-flow", "position", "friends"]);
  });

  it("labels publish times relative to Beijing days", () => {
    const at = new Date("2026-10-28T04:00:00Z");
    expect(publishedLabel("2026-10-28T03:59:30Z", at)).toBe("刚刚");
    expect(publishedLabel("2026-10-27T23:02:00Z", at)).toBe("今天 07:02");
    expect(publishedLabel("2026-10-27T01:00:00Z", at)).toBe("昨天 09:00");
    expect(publishedLabel("2026-10-24T01:00:00Z", at)).toBe("4 天前");
    expect(publishedLabel("2026-10-10T01:00:00Z", at)).toBe("10 月 10 日");
  });
});
