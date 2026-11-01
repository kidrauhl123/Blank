import { z } from "zod";
import { FEED_KINDS } from "./feed";
import { recipeBlockSchema, recipeQuerySchema } from "./feed-recipe";

// 生长式界面的"排版语法"：AI 不写界面代码，只能用审核过的积木按这套语法组装。
// 模板本身是数据（JSON），语法里内建设计规范（数量上限、半宽成对、必须保留的入口……），
// 校验不通过的组合根本进不了系统。界面结构的任何变化都要用户在 APP 里确认才生效。
const NO_DIGITS = /^[^0-9０-９]*$/;
const uuid = z.string().uuid();

export const SYSTEM_PAGES = { home: "首页", wealth: "理财", activity: "明细", cards: "卡片", blank: "Blank" } as const;
export type SystemPageId = keyof typeof SYSTEM_PAGES;
export const PAGE_ICONS = ["grid", "coffee", "plane", "users", "piggy", "chart", "list", "star", "calendar", "heart", "gift", "wallet"] as const;
export type PageIcon = (typeof PAGE_ICONS)[number];

export const KIND_NAMES: Record<(typeof FEED_KINDS)[number], string> = {
  anomaly: "交易核查", "spending-calendar": "消费日历", "money-flow": "资金去向", friends: "朋友往来", "subscription-due": "订阅扣费",
  subscriptions: "订阅总账", position: "理财走势", unlock: "理财解封", custom: "我的卡片", schedule: "定时任务结果", rule: "规矩提醒",
};

export const navItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system"), id: z.enum(["home", "wealth", "activity", "cards", "blank"]) }).strict(),
  z.object({ type: z.literal("page"), pageId: uuid.describe("list_ui 返回的自定义页面编号") }).strict(),
]);
export const sectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assets") }).strict().describe("资产卡"),
  z.object({ type: z.literal("tool"), toolId: uuid.describe("build_tool 返回的 toolId，也可从 list_ui 的 tools 里取") }).strict().describe("一个交互小工具（滑块模拟器、分账表）。用户在小工具卡片上点“保存到首页”也会加上这一项"),
  z.object({
    type: z.literal("feed"),
    title: z.string().trim().min(1).max(12).regex(NO_DIGITS).optional().describe("这一组的小标题（选填）"),
    kinds: z.array(z.enum(FEED_KINDS)).max(10).optional().describe("只放这些类型的帖子"),
    recipeIds: z.array(uuid).max(10).optional().describe("放用户自己创建的这些卡片（list_ui 里的 cards[].id）"),
    excludeKinds: z.array(z.enum(FEED_KINDS)).max(10).optional().describe("不放这些类型"),
    limit: z.number().int().min(1).max(60).default(20).describe("最多几条"),
    latestPerKind: z.boolean().default(false).describe("每种类型只放最新一条"),
  }).strict().describe("动态帖子。kinds 和 recipeIds 都不写表示放所有还没被前面的组拿走的帖子；没有任何一组匹配的帖子不会显示"),
]);

export const layoutSchema = z.object({
  home: z.array(sectionSchema).min(1).max(8).describe("首页从上到下的区块"),
  nav: z.array(navItemSchema).min(2).max(5).describe("底部导航从左到右，最多 5 项"),
}).strict().superRefine((layout, ctx) => {
  const ids = layout.nav.map(item => item.type === "system" ? item.id : `page:${item.pageId}`);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "导航里有重复的项" });
  for (const required of ["home", "blank"]) if (!ids.includes(required)) ctx.addIssue({ code: "custom", message: `导航必须保留「${SYSTEM_PAGES[required as SystemPageId]}」，否则用户找不到回来的路` });
  if (layout.home.filter(section => section.type === "assets").length > 1) ctx.addIssue({ code: "custom", message: "资产卡只能放一次" });
});
export type Layout = z.infer<typeof layoutSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type NavItem = z.infer<typeof navItemSchema>;

export const DEFAULT_LAYOUT: Layout = {
  home: [{ type: "assets" }, { type: "feed", limit: 60, latestPerKind: false }],
  nav: ["home", "wealth", "blank", "activity", "cards"].map(id => ({ type: "system" as const, id: id as SystemPageId })),
};

// 面板 = 一组积木 + 它们共用的一份查询。设计规范写在语法里：
// 半宽面板只能放大数字和备注、必须相邻成对；每页最多 6 个面板；面板标题里不能出现数字。
export const panelSchema = z.object({
  title: z.string().trim().min(1).max(16).regex(NO_DIGITS, "面板标题里不能写数字").describe("面板标题，例如“最近几笔”“按商户排行”"),
  width: z.enum(["full", "half"]).default("full").describe("half 是半宽，只能放 stat 和 note，且必须两个相邻成对，用来并排放两个关键数字"),
  query: recipeQuerySchema,
  blocks: z.array(recipeBlockSchema).min(1).max(3).describe("这个面板里的积木，最多 3 块"),
}).strict().superRefine((panel, ctx) => {
  if (panel.width === "half" && (panel.blocks.length > 2 || panel.blocks.some(block => !["stat", "note"].includes(block.type)))) ctx.addIssue({ code: "custom", message: "半宽面板只能放最多 2 块 stat 或 note" });
});
export const pageSchema = z.object({
  name: z.string().trim().min(1).max(8).regex(NO_DIGITS, "页面名里不能写数字").describe("页面名，会显示在导航里，例如“咖啡专题”“共同开销”"),
  icon: z.enum(PAGE_ICONS).default("grid"),
  panels: z.array(panelSchema).min(1).max(6).describe("页面从上到下的面板，最多 6 个"),
}).strict().superRefine((page, ctx) => {
  const titles = page.panels.map(panel => panel.title);
  if (new Set(titles).size !== titles.length) ctx.addIssue({ code: "custom", message: "面板标题不能重复" });
  for (let index = 0; index < page.panels.length; index++) {
    if (page.panels[index].width !== "half") continue;
    if (page.panels[index + 1]?.width !== "half") { ctx.addIssue({ code: "custom", message: "半宽面板必须两个相邻成对" }); break; }
    index++;
  }
});
export type Page = z.infer<typeof pageSchema>;
export type Panel = z.infer<typeof panelSchema>;

// 以下是 AI 能提出的三种"界面变更提案"，都要用户在 APP 里点“应用”才生效。
export const layoutProposalInput = z.object({
  summary: z.string().trim().min(1).max(60).describe("一句话说明这次改了什么，例如“首页只留理财和咖啡，资产放最下面”"),
  home: layoutSchema.shape.home.optional().describe("新的首页区块；不改首页就不写"),
  nav: layoutSchema.shape.nav.optional().describe("新的底部导航；不改导航就不写"),
  reset: z.boolean().optional().describe("恢复成默认的首页和导航（此时不要再写 home 和 nav）"),
}).strict();
export const pageProposalInput = z.object({
  summary: z.string().trim().min(1).max(60).describe("一句话说明这个页面是做什么的"),
  page: pageSchema,
  replaces: uuid.optional().describe("修改已有页面时填它的 pageId，页面的位置和导航保持不变"),
  addToNav: z.object({ replace: z.enum(["wealth", "activity", "cards"]).optional().describe("导航已满 5 项时，替换掉哪一项") }).strict().optional()
    .describe("新页面必须带上它，把页面放进底部导航（否则没有入口能打开）；导航已满 5 项时用 replace 指明替换哪个系统页面。修改已有页面时不用写"),
}).strict();
export const removePageProposalInput = z.object({ pageId: uuid, summary: z.string().trim().min(1).max(60) }).strict();

export type ProposalKind = "layout" | "page" | "remove-page";
export const proposalPayload = {
  layout: layoutProposalInput, page: pageProposalInput, "remove-page": removePageProposalInput,
} as const;
