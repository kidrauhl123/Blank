import { query, withTransaction } from "./db";
import type { PoolClient } from "pg";
import type { RecipeView } from "./feed";
import { evaluateRecipe, type CardRecipe } from "./feed-recipe";
import { listRecipes, loadTransactions } from "./feed-recipe-store";
import { DEFAULT_LAYOUT, KIND_NAMES, SYSTEM_PAGES, layoutSchema, pageSchema, proposalPayload, type Layout, type NavItem, type Page, type PageIcon, type ProposalKind, type Section } from "./ui-schema";

// 每位访客自己的界面：首页排布、底部导航、自定义页面。结构变化只能经过“提案 → 用户在 APP 里确认”。
const MAX_PAGES = 8;
export type PageMeta = { id: string; name: string; icon: PageIcon };
export type PageView = PageMeta & { panels: Array<{ title: string; width: "full" | "half"; blocks: RecipeView[] }> };

async function pageRows(customerId: string, ownerId: string, client?: PoolClient) {
  const run = client ? client.query.bind(client) : query;
  const rows = await run<{ id: string; page: Page }>("SELECT id,page FROM ui_pages WHERE customer_id=$1 AND visitor_owner_id=$2 AND deleted_at IS NULL ORDER BY created_at", [customerId, ownerId]);
  return rows.rows;
}
export async function listPages(customerId: string, ownerId: string, client?: PoolClient): Promise<PageMeta[]> {
  return (await pageRows(customerId, ownerId, client)).map(row => ({ id: row.id, name: row.page.name, icon: row.page.icon }));
}

// 导航里指向已删除页面的项自动去掉；首页和 Blank 永远在。
function clean(layout: Layout, pages: PageMeta[]): Layout {
  const alive = new Set(pages.map(page => page.id));
  const nav = layout.nav.filter(item => item.type === "system" || alive.has(item.pageId));
  for (const id of ["home", "blank"] as const) if (!nav.some(item => item.type === "system" && item.id === id)) nav.unshift({ type: "system", id });
  return { ...layout, nav: nav.slice(0, 5) };
}
export async function getLayout(customerId: string, ownerId: string | null, client?: PoolClient) {
  if (!ownerId) return { layout: DEFAULT_LAYOUT, pages: [] as PageMeta[] };
  const run = client ? client.query.bind(client) : query;
  const [row, pages] = await Promise.all([
    run<{ layout: unknown }>("SELECT layout FROM ui_layouts WHERE customer_id=$1 AND visitor_owner_id=$2", [customerId, ownerId]),
    listPages(customerId, ownerId, client),
  ]);
  const parsed = layoutSchema.safeParse(row.rows[0]?.layout);
  return { layout: clean(parsed.success ? parsed.data : DEFAULT_LAYOUT, pages), pages };
}

export async function getPageView(customerId: string, ownerId: string, id: string, now = new Date()): Promise<PageView | null> {
  const row = (await query<{ id: string; page: Page }>("SELECT id,page FROM ui_pages WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 AND deleted_at IS NULL", [id, customerId, ownerId])).rows[0];
  const page = row && pageSchema.safeParse(row.page);
  return page?.success ? evaluatePage(customerId, row.id, page.data, now) : null;
}
export async function evaluatePage(customerId: string, id: string, page: Page, now = new Date()): Promise<PageView> {
  const transactions = await loadTransactions(customerId, now);
  return { id, name: page.name, icon: page.icon, panels: page.panels.map(panel => ({ title: panel.title, width: panel.width,
    blocks: evaluateRecipe({ name: panel.title, headline: "{period}", query: panel.query, blocks: panel.blocks, schedule: { every: "day", hour: 8 } } as CardRecipe, transactions, now).blocks })) };
}

// ---- 提案 ----
type LayoutProposal = import("zod").infer<typeof proposalPayload.layout>;
type PageProposal = import("zod").infer<typeof proposalPayload.page>;
function mergeLayout(current: Layout, proposal: LayoutProposal): Layout {
  if (proposal.reset) return DEFAULT_LAYOUT;
  return { home: proposal.home ?? current.home, nav: proposal.nav ?? current.nav };
}
const navKey = (item: NavItem) => item.type === "system" ? item.id : `page:${item.pageId}`;

export async function createProposal(customerId: string, ownerId: string, kind: ProposalKind, raw: unknown): Promise<{ proposalId: string; marker: string } | { error: string }> {
  const parsed = proposalPayload[kind].safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues.map(issue => `${issue.path.join(".") || "参数"}：${issue.message}`).slice(0, 4).join("；") };
  const { layout, pages } = await getLayout(customerId, ownerId);
  const known = new Set(pages.map(page => page.id));
  if (kind === "layout") {
    const input = parsed.data as LayoutProposal;
    if (!input.home && !input.nav && !input.reset) return { error: "没有要改的内容：请给出新的 home、nav，或者 reset。" };
    if (input.reset && (input.home || input.nav)) return { error: "reset 不能和 home、nav 同时给。" };
    const merged = layoutSchema.safeParse(mergeLayout(layout, input));
    if (!merged.success) return { error: merged.error.issues.map(issue => issue.message).slice(0, 3).join("；") };
    const missing = merged.data.nav.find(item => item.type === "page" && !known.has(item.pageId));
    if (missing) return { error: "导航里有不存在的页面，请先用 list_ui 确认页面编号。" };
  } else if (kind === "page") {
    const input = parsed.data as PageProposal;
    if (input.replaces && !known.has(input.replaces)) return { error: "要修改的页面不存在，请先用 list_ui 确认页面编号。" };
    if (!input.replaces && pages.length >= MAX_PAGES) return { error: `最多保留 ${MAX_PAGES} 个自定义页面，请先删掉不用的。` };
    // 没有入口的页面打不开：新页面必须放进底部导航，导航满了要指明替换哪个系统页面。
    if (!input.replaces && !input.addToNav) return { error: "新页面必须同时放进底部导航，否则没有入口能打开它：请带上 addToNav；导航已满 5 项时用 addToNav.replace 指明替换「理财」「明细」「卡片」中的哪一个。" };
    if (!input.replaces && layout.nav.length >= 5 && !input.addToNav?.replace) return { error: "底部导航已满 5 项，请用 addToNav.replace 指明替换「理财」「明细」「卡片」中的哪一个（如果 3 个系统页面都已被页面替换，先用 propose_remove_page 删掉一个旧页面）。" };
  } else if (!known.has((parsed.data as { pageId: string }).pageId)) return { error: "要删除的页面不存在。" };
  const inserted = await query<{ id: string }>("INSERT INTO ui_proposals(customer_id,visitor_owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id", [customerId, ownerId, kind, JSON.stringify(parsed.data)]);
  return { proposalId: inserted.rows[0].id, marker: `[[proposal:${inserted.rows[0].id}]]` };
}

function sectionLabel(section: Section, cards: Map<string, string>) {
  if (section.type === "assets") return { label: "资产", detail: "总资产和活期、理财构成" };
  if (section.type === "tool") return { label: "小工具", detail: "你保存到首页的交互工具" };
  const what = section.kinds?.length || section.recipeIds?.length
    ? [...(section.kinds ?? []).map(kind => KIND_NAMES[kind]), ...(section.recipeIds ?? []).map(id => cards.get(id) ?? "已删除的卡片")].join("、") : "其余动态";
  const extra = [`最多 ${section.limit} 条`, section.latestPerKind ? "每类只放最新一条" : "", section.excludeKinds?.length ? `不含${section.excludeKinds.map(kind => KIND_NAMES[kind]).join("、")}` : ""].filter(Boolean).join("，");
  return { label: section.title ?? what, detail: section.title ? `${what} · ${extra}` : extra };
}

export type ProposalView = {
  id: string; kind: ProposalKind; status: "PENDING" | "APPLIED" | "DISMISSED"; summary: string;
  layout?: { home: Array<{ label: string; detail: string }>; nav: Array<{ label: string; icon: PageIcon | "system"; isPage: boolean }>; changedHome: boolean; changedNav: boolean };
  page?: PageView & { navNote: string; replacing: boolean };
  removing?: { name: string };
};
export async function getProposalView(customerId: string, ownerId: string, id: string): Promise<ProposalView | null> {
  const row = (await query<{ id: string; kind: ProposalKind; payload: unknown; status: ProposalView["status"] }>("SELECT id,kind,payload,status FROM ui_proposals WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3", [id, customerId, ownerId])).rows[0];
  if (!row) return null;
  const parsed = proposalPayload[row.kind].safeParse(row.payload);
  if (!parsed.success) return null;
  const base = { id: row.id, kind: row.kind, status: row.status, summary: (parsed.data as { summary: string }).summary };
  const { layout, pages } = await getLayout(customerId, ownerId);
  const names = new Map(pages.map(page => [page.id, page]));
  if (row.kind === "layout") {
    const input = parsed.data as LayoutProposal;
    // 已应用的提案显示当时的方案，所以直接按提案内容展示，而不是和当前布局对比。
    const next = mergeLayout(layout, input);
    const cards = new Map((await listRecipes(customerId, ownerId)).map(card => [card.id, card.name]));
    return { ...base, layout: { home: next.home.map(section => sectionLabel(section, cards)),
      nav: next.nav.map(item => item.type === "system" ? { label: SYSTEM_PAGES[item.id], icon: "system" as const, isPage: false } : { label: names.get(item.pageId)?.name ?? "已删除的页面", icon: names.get(item.pageId)?.icon ?? "grid", isPage: true }),
      changedHome: JSON.stringify(next.home) !== JSON.stringify(layout.home), changedNav: next.nav.map(navKey).join() !== layout.nav.map(navKey).join() } };
  }
  if (row.kind === "page") {
    const input = parsed.data as PageProposal;
    const replacing = Boolean(input.replaces && names.has(input.replaces));
    const view = await evaluatePage(customerId, input.replaces ?? row.id, input.page);
    const navNote = input.addToNav?.replace ? `会放进底部导航，替换「${SYSTEM_PAGES[input.addToNav.replace]}」` : "会放进底部导航";
    return { ...base, page: { ...view, navNote: replacing ? "替换现有页面，位置不变" : navNote, replacing } };
  }
  return { ...base, removing: { name: names.get((parsed.data as { pageId: string }).pageId)?.name ?? "这个页面" } };
}

async function saveLayout(client: PoolClient, customerId: string, ownerId: string, layout: Layout) {
  await client.query(`INSERT INTO ui_layouts(customer_id,visitor_owner_id,layout) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(customer_id,visitor_owner_id) DO UPDATE SET layout=excluded.layout,updated_at=now()`, [customerId, ownerId, JSON.stringify(layout)]);
}

// 用户在 APP 里点“应用”或“不要”。只有这条路径会改变界面结构，模型没有对应的工具。
export async function decideProposal(customerId: string, ownerId: string, id: string, action: "apply" | "dismiss") {
  return withTransaction(async client => {
    const row = (await client.query<{ kind: ProposalKind; payload: unknown; status: string }>("SELECT kind,payload,status FROM ui_proposals WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 FOR UPDATE", [id, customerId, ownerId])).rows[0];
    if (!row) throw new Error("PROPOSAL_NOT_FOUND");
    if (row.status !== "PENDING") return { status: row.status };
    if (action === "dismiss") { await client.query("UPDATE ui_proposals SET status='DISMISSED',decided_at=now() WHERE id=$1", [id]); return { status: "DISMISSED" }; }
    const parsed = proposalPayload[row.kind].parse(row.payload);
    const { layout, pages } = await getLayout(customerId, ownerId, client);
    if (row.kind === "layout") {
      const merged = layoutSchema.parse(mergeLayout(layout, parsed as LayoutProposal));
      if (merged.nav.some(item => item.type === "page" && !pages.some(page => page.id === item.pageId))) throw new Error("PROPOSAL_STALE");
      await saveLayout(client, customerId, ownerId, merged);
    } else if (row.kind === "page") {
      const input = parsed as PageProposal;
      let pageId = input.replaces ?? "";
      if (input.replaces) {
        const updated = await client.query("UPDATE ui_pages SET page=$2::jsonb,updated_at=now() WHERE id=$1 AND customer_id=$3 AND visitor_owner_id=$4 AND deleted_at IS NULL", [input.replaces, JSON.stringify(input.page), customerId, ownerId]);
        if (!updated.rowCount) throw new Error("PROPOSAL_STALE");
      } else {
        if (pages.length >= MAX_PAGES) throw new Error("PROPOSAL_STALE");
        pageId = (await client.query<{ id: string }>("INSERT INTO ui_pages(customer_id,visitor_owner_id,page) VALUES($1,$2,$3::jsonb) RETURNING id", [customerId, ownerId, JSON.stringify(input.page)])).rows[0].id;
        if (input.addToNav) {
          const item: NavItem = { type: "page", pageId };
          const nav = layout.nav.length < 5 ? [...layout.nav, item] : layout.nav.map(entry => entry.type === "system" && entry.id === input.addToNav!.replace ? item : entry);
          if (nav.length === layout.nav.length && !nav.some(entry => entry.type === "page" && entry.pageId === pageId)) throw new Error("PROPOSAL_STALE");
          await saveLayout(client, customerId, ownerId, layoutSchema.parse({ ...layout, nav }));
        }
      }
    } else {
      const { pageId } = parsed as { pageId: string };
      await client.query("UPDATE ui_pages SET deleted_at=now() WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3", [pageId, customerId, ownerId]);
      await saveLayout(client, customerId, ownerId, clean(layout, pages.filter(page => page.id !== pageId)));
    }
    await client.query("UPDATE ui_proposals SET status='APPLIED',decided_at=now() WHERE id=$1", [id]);
    return { status: "APPLIED" };
  });
}

// ---- 给模型的现状，以及记录“表达不了”的需求 ----
export async function describeUi(customerId: string, ownerId: string) {
  const { layout, pages } = await getLayout(customerId, ownerId);
  const cards = await listRecipes(customerId, ownerId);
  const cardNames = new Map(cards.map(card => [card.id, card.name]));
  return { home: layout.home, nav: layout.nav.map(item => item.type === "system" ? { type: "system", id: item.id, name: SYSTEM_PAGES[item.id] } : { type: "page", pageId: item.pageId, name: pages.find(page => page.id === item.pageId)?.name }),
    pages: pages.map(page => ({ pageId: page.id, name: page.name })), cards: cards.map(card => ({ id: card.id, name: card.name })),
    homeDescription: layout.home.map(section => sectionLabel(section, cardNames)) };
}
export async function recordUnmetNeed(customerId: string, ownerId: string, need: string, closest: string) {
  const count = await query<{ count: number }>("SELECT count(*)::int AS count FROM ui_unmet_needs WHERE customer_id=$1 AND visitor_owner_id=$2", [customerId, ownerId]);
  if (count.rows[0].count >= 200) return;
  await query("INSERT INTO ui_unmet_needs(customer_id,visitor_owner_id,need,closest) VALUES($1,$2,$3,$4)", [customerId, ownerId, need.slice(0, 200), closest.slice(0, 200)]);
}
