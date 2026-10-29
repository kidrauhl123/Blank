import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { DEFAULT_LAYOUT } from "./ui-schema";
import { createProposal, decideProposal, describeUi, getLayout, getPageView, getProposalView, listPages, recordUnmetNeed } from "./ui-store";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("grown interface: layouts, pages and proposals", () => {
  const customerId = randomUUID(), accountId = randomUUID();
  const [alice, bob] = [randomUUID(), randomUUID()];
  const query30 = { direction: "out", merchantKeywords: ["咖啡"], period: "30d", groupBy: "day" };
  const coffeePage = { name: "咖啡专题", icon: "coffee", panels: [
    { title: "合计", width: "half", query: query30, blocks: [{ type: "stat", value: "total" }] },
    { title: "笔数", width: "half", query: query30, blocks: [{ type: "stat", value: "count" }] },
    { title: "最近几笔", width: "full", query: query30, blocks: [{ type: "list", limit: 3 }] },
  ] };
  const proposed = async (owner: string, kind: "layout" | "page" | "remove-page", payload: unknown) => {
    const result = await createProposal(customerId, owner, kind, payload);
    if ("error" in result) throw new Error(result.error);
    return result.proposalId;
  };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'UI test',$2)", [customerId, randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Test','CHECKING','TEST')", [accountId, customerId]);
    for (const id of [alice, bob]) await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [id, randomBytes(32).toString("hex")]);
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES
      ($1,'漫拿咖啡','餐饮',-3200,now() - interval '1 day'),($1,'星杯咖啡','餐饮',-2800,now() - interval '2 days'),($1,'老乡饭馆','餐饮',-4500,now() - interval '1 day')`, [accountId]);
  });
  afterAll(async () => {
    await query("DELETE FROM bank_transactions WHERE account_id=$1", [accountId]);
    await query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await query("DELETE FROM customers WHERE id=$1", [customerId]);
    await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [[alice, bob]]);
    await db.end();
  });

  it("starts from the default layout and never changes anything until the user applies a proposal", async () => {
    expect((await getLayout(customerId, alice)).layout).toEqual(DEFAULT_LAYOUT);
    const id = await proposed(alice, "layout", { summary: "首页只留理财", home: [{ type: "feed", kinds: ["position"], limit: 2 }, { type: "assets" }] });
    expect((await getLayout(customerId, alice)).layout).toEqual(DEFAULT_LAYOUT); // 提案本身不生效
    const view = await getProposalView(customerId, alice, id);
    expect(view).toMatchObject({ kind: "layout", status: "PENDING", summary: "首页只留理财", layout: { changedHome: true, changedNav: false } });
    expect(view?.layout?.home.map(item => item.label)).toEqual(["理财走势", "资产"]);
    expect(await getProposalView(customerId, bob, id)).toBeNull(); // 别人看不到
    await expect(decideProposal(customerId, bob, id, "apply")).rejects.toThrow("PROPOSAL_NOT_FOUND");
    expect(await decideProposal(customerId, alice, id, "apply")).toEqual({ status: "APPLIED" });
    expect((await getLayout(customerId, alice)).layout.home).toHaveLength(2);
    expect((await getLayout(customerId, bob)).layout).toEqual(DEFAULT_LAYOUT);
    expect(await decideProposal(customerId, alice, id, "apply")).toEqual({ status: "APPLIED" }); // 重复点击不会再变
  });

  it("rejects proposals that break the rules with a message the assistant can act on", async () => {
    const noBlank = await createProposal(customerId, alice, "layout", { summary: "x", nav: [{ type: "system", id: "home" }, { type: "system", id: "wealth" }] });
    expect(noBlank).toMatchObject({ error: expect.stringContaining("Blank") });
    expect(await createProposal(customerId, alice, "layout", { summary: "x" })).toMatchObject({ error: expect.stringContaining("没有要改") });
    expect(await createProposal(customerId, alice, "layout", { summary: "x", reset: true, home: DEFAULT_LAYOUT.home })).toMatchObject({ error: expect.stringContaining("reset") });
    expect(await createProposal(customerId, alice, "page", { summary: "x", page: { ...coffeePage, name: "近7天" } })).toMatchObject({ error: expect.stringContaining("数字") });
    expect(await createProposal(customerId, alice, "page", { summary: "x", page: coffeePage })).toMatchObject({ error: expect.stringContaining("必须同时放进底部导航") });
    expect(await createProposal(customerId, alice, "page", { summary: "x", page: coffeePage, replaces: randomUUID() })).toMatchObject({ error: expect.stringContaining("不存在") });
    expect(await createProposal(customerId, alice, "layout", { summary: "x", nav: [{ type: "system", id: "home" }, { type: "system", id: "blank" }, { type: "page", pageId: randomUUID() }] })).toMatchObject({ error: expect.stringContaining("不存在") });
  });

  it("grows a page with numbers from the ledger, puts it in the nav, and the page belongs to its visitor", async () => {
    const id = await proposed(alice, "page", { summary: "看咖啡花了多少", page: coffeePage, addToNav: { replace: "cards" } });
    const view = await getProposalView(customerId, alice, id);
    expect(view?.page).toMatchObject({ name: "咖啡专题", navNote: "会放进底部导航，替换「卡片」" });
    expect(view?.page?.panels[0].blocks).toEqual([{ type: "stat", label: "合计", text: "¥60" }]);
    expect(view?.page?.panels[2].blocks[0]).toMatchObject({ type: "list", items: [{ label: "漫拿咖啡", minor: 3200 }, { label: "星杯咖啡", minor: 2800 }] });
    expect(await listPages(customerId, alice)).toEqual([]); // 还没应用
    await decideProposal(customerId, alice, id, "apply");
    const { layout, pages } = await getLayout(customerId, alice);
    expect(pages).toEqual([expect.objectContaining({ name: "咖啡专题", icon: "coffee" })]);
    expect(layout.nav.map(item => item.type === "system" ? item.id : "page")).toEqual(["home", "wealth", "blank", "activity", "page"]);
    const page = await getPageView(customerId, alice, pages[0].id);
    expect(page?.panels.map(panel => panel.title)).toEqual(["合计", "笔数", "最近几笔"]);
    expect(await getPageView(customerId, bob, pages[0].id)).toBeNull();
    expect((await getLayout(customerId, bob)).pages).toEqual([]);
    expect((await describeUi(customerId, alice)).pages).toEqual([{ pageId: pages[0].id, name: "咖啡专题" }]);
  });

  it("asks which system page to replace when the nav is full, edits a page in place, and removing a page cleans the nav", async () => {
    const [existing] = (await getLayout(customerId, alice)).pages;
    expect(await createProposal(customerId, alice, "page", { summary: "再来一个", page: { ...coffeePage, name: "第二页" }, addToNav: {} })).toMatchObject({ error: expect.stringContaining("replace") });
    const edit = await proposed(alice, "page", { summary: "改成按商户排行", replaces: existing.id, page: { ...coffeePage, panels: [{ title: "哪家最多", width: "full", query: { ...query30, groupBy: "merchant" }, blocks: [{ type: "ranking", limit: 3 }] }] } });
    await decideProposal(customerId, alice, edit, "apply");
    expect((await getPageView(customerId, alice, existing.id))?.panels.map(panel => panel.title)).toEqual(["哪家最多"]);
    expect((await getLayout(customerId, alice)).layout.nav.some(item => item.type === "page" && item.pageId === existing.id)).toBe(true);
    const removal = await proposed(alice, "remove-page", { pageId: existing.id, summary: "删掉咖啡专题" });
    expect(await getProposalView(customerId, alice, removal)).toMatchObject({ removing: { name: "咖啡专题" } });
    await decideProposal(customerId, alice, removal, "apply");
    expect(await getPageView(customerId, alice, existing.id)).toBeNull();
    const nav = (await getLayout(customerId, alice)).layout.nav;
    expect(nav.some(item => item.type === "page")).toBe(false);
    expect(nav.length).toBe(4);
  });

  it("a dismissed proposal changes nothing, and reset restores the defaults", async () => {
    const before = (await getLayout(customerId, alice)).layout;
    const dismissed = await proposed(alice, "layout", { summary: "不要", home: [{ type: "assets" }] });
    expect(await decideProposal(customerId, alice, dismissed, "dismiss")).toEqual({ status: "DISMISSED" });
    expect(await decideProposal(customerId, alice, dismissed, "apply")).toEqual({ status: "DISMISSED" });
    expect((await getLayout(customerId, alice)).layout).toEqual(before);
    const reset = await proposed(alice, "layout", { summary: "恢复默认", reset: true });
    await decideProposal(customerId, alice, reset, "apply");
    expect((await getLayout(customerId, alice)).layout).toEqual(DEFAULT_LAYOUT);
  });

  it("records needs the blocks cannot express, per visitor", async () => {
    await recordUnmetNeed(customerId, alice, "想看 A 股实时行情", "只放了理财走势帖子");
    const rows = await query<{ need: string; closest: string; visitor_owner_id: string }>("SELECT need,closest,visitor_owner_id FROM ui_unmet_needs WHERE customer_id=$1", [customerId]);
    expect(rows.rows).toEqual([{ need: "想看 A 股实时行情", closest: "只放了理财走势帖子", visitor_owner_id: alice }]);
  });
});
