import { z } from "zod";
import { dateKey, weekStart, yuan, type FeedDraft, type FeedTransaction, type RecipeView } from "./feed";

// 卡片配方：AI 和用户一起设计的动态卡片。配方只能描述"看哪些流水、用哪些积木、多久发一次"，
// 不能执行代码或写 SQL；所有数字都由服务端按账本计算，标题与备注里不允许 AI 自己写数字。
const NO_DIGITS = /^[^0-9０-９]*$/;
const PLACEHOLDERS = ["total", "count", "avg", "change", "top", "period"] as const;
const withoutPlaceholders = (text: string) => text.replace(new RegExp(`\\{(${PLACEHOLDERS.join("|")})\\}`, "g"), "");

// 查询与积木同时给"动态卡片"和"自定义页面的面板"使用。
export const recipeQuerySchema = z.object({
  direction: z.enum(["out", "in", "both"]).default("out").describe("out 支出，in 收入，both 收支都看（看和某个人的往来时用，配合“净额”大数字）"),
  categories: z.array(z.string().trim().min(1).max(8)).max(6).optional().describe("只看这些分类，例如 餐饮、交通、购物、订阅、转账、理财"),
  merchantKeywords: z.array(z.string().trim().min(1).max(12)).max(6).optional().describe("商户名包含任一关键词，例如 咖啡、外卖；转账的商户名是“转账给小板栗”“来自小板栗的转账”，所以关键词写人名就能看到和他的往来"),
  period: z.enum(["7d", "week", "30d", "month", "90d"]).describe("7d 近7天，week 本周，30d 近30天，month 本月，90d 近90天"),
  groupBy: z.enum(["day", "week", "category", "merchant"]).describe("趋势按 day/week 分组；排行按 category/merchant 分组"),
});
export const recipeBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stat"), value: z.enum(["total", "count", "avg", "change", "top", "net"]), label: z.string().trim().min(1).max(12).regex(NO_DIGITS).optional() }),
  z.object({ type: z.literal("trend") }),
  z.object({ type: z.literal("ranking"), limit: z.number().int().min(2).max(6).default(5) }),
  z.object({ type: z.literal("calendar") }),
  z.object({ type: z.literal("list"), limit: z.number().int().min(2).max(6).default(4) }),
  z.object({ type: z.literal("compare") }),
  z.object({ type: z.literal("note"), text: z.string().trim().min(1).max(80).regex(NO_DIGITS, "备注里不能写数字") }),
]);
export const recipeSchema = z.object({
  name: z.string().trim().min(1).max(20).describe("卡片名，例如“咖啡周报”"),
  headline: z.string().trim().min(1).max(60)
    .refine(text => NO_DIGITS.test(withoutPlaceholders(text)), "标题里的数字必须用占位符")
    .refine(text => !/\{(?!(?:total|count|avg|change|top|period)\})[^}]*\}/.test(text), "只能使用 {total}{count}{avg}{change}{top}{period}")
    .describe("标题模板，数字只能用占位符：{total}合计 {count}笔数 {avg}平均每笔 {change}与上期相比 {top}最多的分类或商户 {period}时间范围"),
  query: recipeQuerySchema,
  blocks: z.array(recipeBlockSchema).min(1).max(4).describe("卡片积木，从上到下排列，最多 4 块"),
  schedule: z.object({
    every: z.enum(["day", "week", "month"]),
    weekday: z.number().int().min(1).max(7).optional().describe("每周几发，1=周一"),
    day: z.number().int().min(1).max(28).optional().describe("每月几号发"),
    hour: z.number().int().min(6).max(22).default(8).describe("几点发（北京时间）"),
  }),
  onlyWhenAbove: z.number().int().positive().max(100_000_000).optional().describe("单位分；只有合计超过它才发"),
}).strict();
export type CardRecipe = z.infer<typeof recipeSchema>;

const DAY = 86_400_000;
const PERIOD_LABEL: Record<CardRecipe["query"]["period"], string> = { "7d": "近 7 天", week: "本周", "30d": "近 30 天", month: "本月", "90d": "近 90 天" };
const PREVIOUS_LABEL: Record<CardRecipe["query"]["period"], string> = { "7d": "之前 7 天", week: "上周同期", "30d": "之前 30 天", month: "上月同期", "90d": "之前 90 天" };
const at = (date: string, time = "00:00") => new Date(`${date}T${time}:00+08:00`);
const shortDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 当前窗口与等长的上一窗口；本周、本月与上周、上月的同一时段比较。
export function recipeWindow(period: CardRecipe["query"]["period"], now: Date) {
  const today = dateKey(now);
  let start: Date, previousStart: Date, previousEnd: Date;
  if (period === "week") { start = at(weekStart(now)); previousStart = new Date(start.getTime() - 7 * DAY); previousEnd = new Date(now.getTime() - 7 * DAY); }
  else if (period === "month") {
    start = at(`${today.slice(0, 7)}-01`);
    const [year, month] = today.slice(0, 7).split("-").map(Number);
    const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
    previousStart = at(`${previous}-01`);
    previousEnd = new Date(previousStart.getTime() + (now.getTime() - start.getTime()));
  } else {
    const days = { "7d": 7, "30d": 30, "90d": 90 }[period];
    start = new Date(now.getTime() - days * DAY); previousStart = new Date(start.getTime() - days * DAY); previousEnd = start;
  }
  return { start, end: now, previousStart, previousEnd };
}

function matches(query: CardRecipe["query"], item: FeedTransaction) {
  if (query.direction === "out" ? item.amount_minor >= 0 : query.direction === "in" && item.amount_minor <= 0) return false;
  if (query.categories?.length && !query.categories.includes(item.category)) return false;
  if (query.merchantKeywords?.length && !query.merchantKeywords.some(word => item.merchant_name.includes(word))) return false;
  return true;
}

function groupTotals(items: FeedTransaction[], key: (item: FeedTransaction) => string) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + Math.abs(item.amount_minor));
  return [...totals].sort((a, b) => b[1] - a[1]);
}

export type RecipeValues = { total: number; count: number; avg: number; previous: number; change: number | null; top: string | null; period: string; net: number };

export function evaluateRecipe(recipe: CardRecipe, transactions: FeedTransaction[], now: Date) {
  const window = recipeWindow(recipe.query.period, now);
  const inside = (item: FeedTransaction, from: Date, to: Date) => { const time = new Date(item.occurred_at).getTime(); return time >= from.getTime() && time <= to.getTime(); };
  const matching = transactions.filter(item => matches(recipe.query, item));
  const current = matching.filter(item => inside(item, window.start, window.end)).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const previous = matching.filter(item => inside(item, window.previousStart, window.previousEnd));
  const total = current.reduce((sum, item) => sum + Math.abs(item.amount_minor), 0);
  const net = current.reduce((sum, item) => sum + item.amount_minor, 0);
  const previousTotal = previous.reduce((sum, item) => sum + Math.abs(item.amount_minor), 0);
  const rankBy = recipe.query.groupBy === "category" ? (item: FeedTransaction) => item.category : (item: FeedTransaction) => item.merchant_name;
  const ranked = groupTotals(current, rankBy);
  const values: RecipeValues = { total, count: current.length, avg: current.length ? Math.round(total / current.length) : 0, previous: previousTotal,
    change: previousTotal ? Math.round((total - previousTotal) / previousTotal * 100) : null, top: ranked[0]?.[0] ?? null, period: PERIOD_LABEL[recipe.query.period], net };

  const text = (value: Exclude<keyof RecipeValues, "previous">) => {
    if (value === "net") return net === 0 ? "收支持平" : `净${net > 0 ? "流入" : "流出"} ${yuan(net)}`;
    if (value === "total" || value === "avg") return yuan(values[value]);
    if (value === "count") return `${values.count} 笔`;
    if (value === "top") return values.top ?? "暂无";
    if (value === "period") return values.period;
    if (values.change === null) return previousTotal ? "和上期持平" : "上期没有记录";
    return values.change === 0 ? "和上期持平" : `比${PREVIOUS_LABEL[recipe.query.period]}${values.change > 0 ? "多" : "少"} ${Math.abs(values.change)}%`;
  };
  const headline = recipe.headline.replace(/\{(total|count|avg|change|top|period)\}/g, (_, key) => text(key));

  // 趋势：按天或按周把当前窗口切成桶，虚线是每桶平均值。
  const trend = (): RecipeView => {
    const byWeek = recipe.query.groupBy === "week" || recipe.query.period === "90d";
    const step = byWeek ? 7 * DAY : DAY;
    const buckets: Array<{ date: string; minor: number }> = [];
    for (let time = window.start.getTime(); time <= window.end.getTime(); time += step) buckets.push({ date: dateKey(new Date(time)), minor: 0 });
    for (const item of current) {
      const index = Math.min(buckets.length - 1, Math.floor((new Date(item.occurred_at).getTime() - window.start.getTime()) / step));
      buckets[index].minor += Math.abs(item.amount_minor);
    }
    const points = buckets.length >= 2 ? buckets : [{ date: dateKey(window.start), minor: 0 }, ...buckets];
    return { type: "line", points, baselineMinor: Math.round(points.reduce((sum, point) => sum + point.minor, 0) / points.length), baselineLabel: byWeek ? "每周平均" : "每天平均" };
  };
  const calendar = (): RecipeView => {
    const start = at(weekStart(now)).getTime() - 28 * DAY;
    const days = Array.from({ length: 35 }, (_, index) => { const date = dateKey(new Date(start + index * DAY + 12 * 3600_000)); return { date, minor: 0, ...(date > dateKey(now) ? { future: true } : {}) }; });
    const byDate = new Map(days.map(day => [day.date, day]));
    for (const item of matching) { const day = byDate.get(dateKey(new Date(item.occurred_at))); if (day && !day.future && new Date(item.occurred_at) <= now) day.minor += Math.abs(item.amount_minor); }
    return { type: "calendar", days };
  };
  const blocks: RecipeView[] = recipe.blocks.map(block => {
    if (block.type === "stat") return { type: "stat", label: block.label ?? { total: "合计", count: "笔数", avg: "平均每笔", change: "与上期相比", top: recipe.query.groupBy === "category" ? "最多的分类" : "最多的商户", net: "净额" }[block.value], text: text(block.value) };
    if (block.type === "trend") return trend();
    if (block.type === "ranking") return { type: "bars", items: ranked.slice(0, block.limit).map(([label, minor]) => ({ label, minor, note: `${current.filter(item => rankBy(item) === label).length} 笔` })) };
    if (block.type === "calendar") return calendar();
    if (block.type === "list") return { type: "list", items: current.slice(0, block.limit).map(item => ({ label: item.merchant_name, note: shortDay(dateKey(new Date(item.occurred_at))), minor: Math.abs(item.amount_minor) })) };
    if (block.type === "compare") return { type: "compare", current: total, previous: previousTotal, currentLabel: PERIOD_LABEL[recipe.query.period], previousLabel: PREVIOUS_LABEL[recipe.query.period] };
    return { type: "note", text: block.text };
  });
  return { headline, values, blocks, factIds: current.map(item => item.id) };
}

// 节奏：每个周期一个去重键；到了约定的星期/日期和钟点才算到期。force 用于刚保存时立刻发出本周期的第一条。
export function recipePeriodKey(recipe: CardRecipe, now: Date, force = false) {
  const today = dateKey(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(now));
  const weekday = ((new Date(at(today, "12:00")).getUTCDay() + 6) % 7) + 1;
  const { every, hour: due = 8 } = recipe.schedule;
  if (every === "day") return force || hour >= due ? today : null;
  if (every === "week") { const target = recipe.schedule.weekday ?? 1; return force || weekday > target || weekday === target && hour >= due ? weekStart(now) : null; }
  const target = recipe.schedule.day ?? 1;
  const dom = Number(today.slice(8, 10));
  return force || dom > target || dom === target && hour >= due ? today.slice(0, 7) : null;
}

const SCHEDULE_TEXT = (recipe: CardRecipe) => recipe.schedule.every === "day" ? `每天 ${recipe.schedule.hour ?? 8} 点`
  : recipe.schedule.every === "week" ? `每周${"一二三四五六日"[(recipe.schedule.weekday ?? 1) - 1]} ${recipe.schedule.hour ?? 8} 点`
  : `每月 ${recipe.schedule.day ?? 1} 号 ${recipe.schedule.hour ?? 8} 点`;

export function recipeDraft(id: string, recipe: CardRecipe, transactions: FeedTransaction[], now: Date, periodKey: string): FeedDraft | null {
  const result = evaluateRecipe(recipe, transactions, now);
  if (recipe.onlyWhenAbove && result.values.total <= recipe.onlyWhenAbove) return null;
  return { key: `recipe:${id}:${periodKey}`, kind: "custom", title: result.headline, body: `你创建的「${recipe.name}」，${SCHEDULE_TEXT(recipe)}更新${recipe.onlyWhenAbove ? `，合计超过 ${yuan(recipe.onlyWhenAbove)} 才发` : ""}。`,
    source: recipe.name, attention: false, chart: { type: "recipe", blocks: result.blocks }, factIds: result.factIds };
}
