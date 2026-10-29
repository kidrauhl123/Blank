import { query } from "./db";
import type { FeedDraft, FeedPost, FeedTransaction } from "./feed";
import { evaluateRecipe, recipeDraft, recipePeriodKey, recipeSchema, type CardRecipe } from "./feed-recipe";

// 配方的存取与发布。每个配方只属于创建它的访客（演示账户由访客共用）。
type RecipeRow = { id: string; status: string; recipe: CardRecipe; visitor_owner_id: string };

export async function loadTransactions(customerId: string, asOf: Date): Promise<FeedTransaction[]> {
  const rows = await query<Omit<FeedTransaction, "amount_minor" | "occurred_at"> & { amount_minor: string; occurred_at: Date }>(
    `SELECT bt.id,bt.merchant_name,bt.category,bt.amount_minor,bt.occurred_at,bt.is_anomaly
     FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
     WHERE a.customer_id=$1 AND bt.occurred_at <= $2 AND bt.occurred_at >= $2::timestamptz - interval '200 days'
     ORDER BY bt.occurred_at DESC LIMIT 3000`, [customerId, asOf]);
  return rows.rows.map(row => ({ ...row, amount_minor: Number(row.amount_minor), occurred_at: row.occurred_at.toISOString() }));
}

async function insertPost(customerId: string, ownerId: string, recipeId: string, draft: FeedDraft, publishedAt: Date) {
  const inserted = await query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,published_at,visitor_owner_id,recipe_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
  [customerId, draft.key, draft.kind, draft.title, draft.body, draft.source, draft.attention, JSON.stringify(draft.chart), draft.factIds, publishedAt, ownerId, recipeId]);
  return inserted.rowCount ?? 0;
}

function preview(id: string, recipe: CardRecipe, transactions: FeedTransaction[], now: Date): FeedPost {
  const draft = recipeDraft(id, { ...recipe, onlyWhenAbove: undefined }, transactions, now, "preview")!;
  return { id, kind: draft.kind, title: draft.title, body: draft.body, source: draft.source, attention: false, chart: draft.chart, factIds: draft.factIds,
    publishedAt: now.toISOString(), recipeId: id };
}

// 校验并存成草稿，返回按当前账本算出的预览；用户确认前不会出现在动态里。
export async function previewRecipe(customerId: string, ownerId: string, raw: unknown) {
  const recipe = recipeSchema.parse(raw);
  const row = await query<{ id: string }>("INSERT INTO feed_recipes(customer_id,visitor_owner_id,recipe) VALUES($1,$2,$3::jsonb) RETURNING id", [customerId, ownerId, JSON.stringify(recipe)]);
  const now = new Date();
  const transactions = await loadTransactions(customerId, now);
  return { id: row.rows[0].id, post: preview(row.rows[0].id, recipe, transactions, now), values: evaluateRecipe(recipe, transactions, now).values };
}

async function ownRecipe(customerId: string, ownerId: string, id: string) {
  const row = await query<RecipeRow>("SELECT id,status,recipe,visitor_owner_id FROM feed_recipes WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3", [id, customerId, ownerId]);
  return row.rows[0] ?? null;
}

export async function getRecipePreview(customerId: string, ownerId: string, id: string) {
  const row = await ownRecipe(customerId, ownerId, id);
  if (!row || row.status === "DELETED") return null;
  const now = new Date();
  return { status: row.status as "DRAFT" | "ACTIVE", post: preview(row.id, row.recipe, await loadTransactions(customerId, now), now) };
}

// 启用草稿并立刻发出本周期的第一条；replaces 用于"改一改"：旧配方和它的帖子一并移除。
// 不传 id 时保存这位访客 30 分钟内最近的一张预览：用户可能在新的对话里才说"好"。
export async function saveRecipe(customerId: string, ownerId: string, id?: string, replaces?: string) {
  if (!id) {
    const latest = await query<{ id: string }>(`SELECT id FROM feed_recipes WHERE customer_id=$1 AND visitor_owner_id=$2 AND status='DRAFT'
      AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1`, [customerId, ownerId]);
    id = latest.rows[0]?.id;
    if (!id) throw new Error("RECIPE_NOT_FOUND");
  }
  const row = await ownRecipe(customerId, ownerId, id);
  if (!row || row.status === "DELETED") throw new Error("RECIPE_NOT_FOUND");
  await query("UPDATE feed_recipes SET status='ACTIVE',updated_at=now() WHERE id=$1", [id]);
  if (replaces && replaces !== id) await deleteRecipe(customerId, ownerId, replaces);
  const now = new Date();
  const draft = recipeDraft(id, row.recipe, await loadTransactions(customerId, now), now, recipePeriodKey(row.recipe, now, true)!);
  const published = draft ? await insertPost(customerId, ownerId, id, draft, now) : 0;
  return { id, published: published > 0, name: row.recipe.name };
}

export async function deleteRecipe(customerId: string, ownerId: string, id: string) {
  const updated = await query("UPDATE feed_recipes SET status='DELETED',updated_at=now() WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 AND status<>'DELETED'", [id, customerId, ownerId]);
  await query("DELETE FROM feed_posts WHERE recipe_id=$1 AND customer_id=$2", [id, customerId]);
  return (updated.rowCount ?? 0) > 0;
}

export async function listRecipes(customerId: string, ownerId: string) {
  const rows = await query<RecipeRow & { created_at: Date }>("SELECT id,status,recipe,visitor_owner_id,created_at FROM feed_recipes WHERE customer_id=$1 AND visitor_owner_id=$2 AND status='ACTIVE' ORDER BY created_at", [customerId, ownerId]);
  return rows.rows.map(row => ({ id: row.id, name: row.recipe.name, schedule: row.recipe.schedule, createdAt: row.created_at.toISOString() }));
}

// 调度器发帖时一并检查这位客户的配方：到了约定周期就按当时的账本发一条。
export async function publishRecipes(customerId: string, asOf: Date) {
  const rows = await query<RecipeRow>("SELECT id,status,recipe,visitor_owner_id FROM feed_recipes WHERE customer_id=$1 AND status='ACTIVE'", [customerId]);
  if (!rows.rows.length) return 0;
  const transactions = await loadTransactions(customerId, asOf);
  let published = 0;
  for (const row of rows.rows) {
    const recipe = recipeSchema.safeParse(row.recipe);
    if (!recipe.success) continue;
    const period = recipePeriodKey(recipe.data, asOf);
    const draft = period && recipeDraft(row.id, recipe.data, transactions, asOf, period);
    if (draft) published += await insertPost(customerId, row.visitor_owner_id, row.id, draft, asOf);
  }
  return published;
}
