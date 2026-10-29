import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, layoutSchema, pageSchema, panelSchema } from "./ui-schema";

const id = "00000000-0000-4000-8000-000000000001";
const query = { direction: "out", merchantKeywords: ["咖啡"], period: "30d", groupBy: "day" } as const;
const panel = (title: string, width: "full" | "half" = "full", blocks: unknown[] = [{ type: "trend" }]) => ({ title, width, query, blocks });

describe("layout grammar", () => {
  it("accepts the default layout and keeps Home and Blank in the nav", () => {
    expect(layoutSchema.safeParse(DEFAULT_LAYOUT).success).toBe(true);
    const nav = (...ids: string[]) => ids.map(entry => ({ type: "system", id: entry }));
    const home = DEFAULT_LAYOUT.home;
    expect(layoutSchema.safeParse({ home, nav: nav("home", "blank") }).success).toBe(true);
    expect(layoutSchema.safeParse({ home, nav: nav("home", "wealth") }).success).toBe(false); // 没有 Blank
    expect(layoutSchema.safeParse({ home, nav: nav("blank", "wealth") }).success).toBe(false); // 没有首页
    expect(layoutSchema.safeParse({ home, nav: nav("home", "blank", "blank") }).success).toBe(false);
    expect(layoutSchema.safeParse({ home, nav: nav("home", "blank", "wealth", "activity", "cards", "home") }).success).toBe(false); // 超过 5 项
  });
  it("allows one assets card and limits sections", () => {
    const assets = { type: "assets" };
    expect(layoutSchema.safeParse({ ...DEFAULT_LAYOUT, home: [assets, assets] }).success).toBe(false);
    expect(layoutSchema.safeParse({ ...DEFAULT_LAYOUT, home: [] }).success).toBe(false);
    expect(layoutSchema.safeParse({ ...DEFAULT_LAYOUT, home: [{ type: "feed", kinds: ["position"], limit: 2 }, { type: "feed", recipeIds: [id], limit: 1 }, assets] }).success).toBe(true);
    expect(layoutSchema.safeParse({ ...DEFAULT_LAYOUT, home: [{ type: "feed", kinds: ["horoscope"] }] }).success).toBe(false);
    expect(layoutSchema.safeParse({ ...DEFAULT_LAYOUT, home: [{ type: "html", html: "<script>" }] }).success).toBe(false);
  });
});

describe("page grammar", () => {
  const page = (...panels: unknown[]) => ({ name: "咖啡专题", icon: "coffee", panels });
  it("accepts a well formed page and rejects unknown blocks and icons", () => {
    expect(pageSchema.safeParse(page(panel("合计", "half", [{ type: "stat", value: "total" }]), panel("与上期", "half", [{ type: "stat", value: "change" }]), panel("每日走势"), panel("最近几笔", "full", [{ type: "list" }]))).success).toBe(true);
    expect(pageSchema.safeParse({ ...page(panel("走势")), icon: "rocket" }).success).toBe(false);
    expect(pageSchema.safeParse(page(panel("走势", "full", [{ type: "iframe", src: "x" }]))).success).toBe(false);
    expect(pageSchema.safeParse({ ...page(panel("走势")), script: "alert(1)" }).success).toBe(false);
  });
  it("enforces the design rules: half panels pair up and hold only numbers, no digits in names, no repeated titles, at most 6 panels", () => {
    const half = (title: string) => panel(title, "half", [{ type: "stat", value: "total" }]);
    expect(pageSchema.safeParse(page(half("合计"), panel("走势"))).success).toBe(false); // 落单的半宽
    expect(pageSchema.safeParse(page(half("合计"), half("笔数"), half("净额"))).success).toBe(false);
    expect(panelSchema.safeParse(panel("走势", "half", [{ type: "trend" }])).success).toBe(false); // 半宽不能放图
    expect(panelSchema.safeParse(panel("合计", "half", [{ type: "stat", value: "total" }, { type: "note", text: "本月" }, { type: "note", text: "再一句" }])).success).toBe(false);
    expect(pageSchema.safeParse({ ...page(panel("走势")), name: "近7天咖啡" }).success).toBe(false);
    expect(pageSchema.safeParse(page(panel("近 7 天走势"))).success).toBe(false);
    expect(pageSchema.safeParse(page(panel("走势"), panel("走势"))).success).toBe(false);
    expect(pageSchema.safeParse(page(...Array.from({ length: 7 }, (_, index) => panel(`面板${"甲乙丙丁戊己庚"[index]}`)))).success).toBe(false);
    expect(pageSchema.safeParse(page()).success).toBe(false);
  });
});
