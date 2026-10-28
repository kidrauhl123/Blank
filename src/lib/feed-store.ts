import { query } from "./db";
import { buildFeed, type FeedChart, type FeedDraft, type FeedPosition, type FeedPost, type FeedSubscription, type FeedTransaction } from "./feed";
import { getInvestmentOverview } from "./investments";
import { investmentValue } from "./investment-model";
import { publishRecipes } from "./feed-recipe-store";

const PUBLISH_INTERVAL = "10 minutes";
// 每条帖子按去重键错开发布时间，像 AI 在不同时刻想到的：事件类 2–9 分钟后，其余在检查后一个半小时内；但不晚于现在。
function publishTime(draft: FeedDraft, asOf: Date, index: number) {
  let hash = 0;
  for (const char of draft.key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const minutes = draft.attention ? 2 + hash % 8 : hash % 96;
  return new Date(Math.min(Date.now(), asOf.getTime() + minutes * 60_000 + (hash % 50) * 1000) + index);
}
// 展示账户还在补齐过去的日子时，动态只按回放时间发布，常规发帖先让路（见 demo-life）。
const CATCHING_UP = `EXISTS (SELECT 1 FROM demo_life_state l WHERE l.customer_id=c.id
  AND l.simulated_through + 1 < (now() AT TIME ZONE 'Asia/Shanghai')::date)`;

async function loadFacts(customerId: string, asOf: Date) {
  const [transactions, subscriptions, investments] = await Promise.all([
    query<Omit<FeedTransaction, "amount_minor" | "occurred_at"> & { amount_minor: string; occurred_at: Date }>(
      `SELECT bt.id,bt.merchant_name,bt.category,bt.amount_minor,bt.occurred_at,bt.is_anomaly
       FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       WHERE a.customer_id=$1 AND bt.occurred_at <= $2 AND bt.occurred_at >= $2::timestamptz - interval '60 days'
       ORDER BY bt.occurred_at DESC LIMIT 500`,
      [customerId, asOf],
    ),
    query<Omit<FeedSubscription, "amount_minor" | "next_charge_at"> & { amount_minor: string; next_charge_at: Date }>(
      "SELECT id,merchant_name,amount_minor,next_charge_at,status FROM subscriptions WHERE customer_id=$1",
      [customerId],
    ),
    getInvestmentOverview(customerId),
  ]);
  const positions: FeedPosition[] = investments.positions.map(position => ({
    id: position.id, productName: position.productName, costMinor: position.costMinor, valueMinor: position.valueMinor,
    profitMinor: position.profitMinor, purchasedOn: position.purchasedOn, unlocksOn: position.unlocksOn, redeemable: position.redeemable,
    businessDate: investments.businessDate,
    history: (investments.products.find(product => product.id === position.productId)?.history ?? [])
      .map(point => ({ date: point.date, valueMinor: investmentValue(position.quantityMicro, point.navMicros) })),
  }));
  return {
    transactions: transactions.rows.map(row => ({ ...row, amount_minor: Number(row.amount_minor), occurred_at: row.occurred_at.toISOString() })),
    subscriptions: subscriptions.rows.map(row => ({ ...row, amount_minor: Number(row.amount_minor), next_charge_at: row.next_charge_at.toISOString() })),
    positions,
  };
}

// 发布到期的新帖：同一去重键已经发过就跳过，所以重复调用是安全的。
// asOf 是"站在哪个时刻看账户"：平时是现在，展示账户补齐历史时是回放的那个时刻，发布时间也记为它。
export async function publishFeed(customerId: string, asOf = new Date()) {
  const drafts = buildFeed(await loadFacts(customerId, asOf), asOf);
  let published = 0;
  // 列表按发布时间倒序，同一批里越重要的帖子时间越晚、排得越靠上。
  for (const [index, draft] of [...drafts].reverse().entries()) {
    // 没有新变化就不发：和同类上一条的标题完全一样，说明事实没变，像机器在刷屏。
    if (!draft.attention) {
      const last = await query<{ title: string }>("SELECT title FROM feed_posts WHERE customer_id=$1 AND kind=$2 AND visitor_owner_id IS NULL AND published_at<=$3 ORDER BY published_at DESC LIMIT 1", [customerId, draft.kind, asOf]);
      if (last.rows[0]?.title === draft.title) continue;
    }
    const inserted = await query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,published_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
    [customerId, draft.key, draft.kind, draft.title, draft.body, draft.source, draft.attention, JSON.stringify(draft.chart), draft.factIds, publishTime(draft, asOf, index)]);
    published += inserted.rowCount ?? 0;
  }
  // 用户配方只按"现在"发布；补过去的日子时不替配方补发旧帖。
  if (Date.now() - asOf.getTime() < 15 * 60_000) published += await publishRecipes(customerId, asOf);
  await query(`INSERT INTO feed_publisher_state(customer_id,checked_at) VALUES($1,now())
    ON CONFLICT(customer_id) DO UPDATE SET checked_at=excluded.checked_at`, [customerId]);
  return published;
}

// 调度器每次 tick 最多替几位客户检查一次，每位客户十分钟内只检查一次。
export async function publishDueFeeds(limit = 5) {
  const due = await query<{ id: string }>(`SELECT c.id FROM customers c LEFT JOIN feed_publisher_state s ON s.customer_id=c.id
    WHERE c.status='ACTIVE' AND (s.checked_at IS NULL OR s.checked_at < now() - interval '${PUBLISH_INTERVAL}') AND NOT ${CATCHING_UP}
    ORDER BY s.checked_at NULLS FIRST LIMIT $1`, [limit]);
  let published = 0;
  for (const { id } of due.rows) {
    try { published += await publishFeed(id); } catch { /* 单个客户失败不影响其他客户，下一轮再试 */ }
  }
  return published;
}

// ownerId 是当前访客：系统帖子大家都能看到，配方帖子只给创建它的访客。
export async function listFeed(customerId: string, ownerId: string | null = null): Promise<FeedPost[]> {
  const read = () => query<{ id: string; kind: FeedPost["kind"]; title: string; body: string; source: string; attention: boolean; chart: FeedChart; fact_ids: string[]; published_at: Date; recipe_id: string | null }>(
    `SELECT id,kind,title,body,source,attention,chart,fact_ids,published_at,recipe_id FROM feed_posts
     WHERE customer_id=$1 AND (visitor_owner_id IS NULL OR visitor_owner_id=$2) ORDER BY published_at DESC,attention DESC,id LIMIT 60`, [customerId, ownerId]);
  let rows = (await read()).rows;
  // 第一次打开时还没有任何帖子，就地发布一次，不必等后台下一轮。
  if (!rows.length) {
    const catchingUp = await query(`SELECT 1 FROM customers c WHERE c.id=$1 AND ${CATCHING_UP}`, [customerId]);
    if (!catchingUp.rowCount) { await publishFeed(customerId); rows = (await read()).rows; }
  }
  return rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, source: row.source, attention: row.attention,
    chart: row.chart, factIds: row.fact_ids, publishedAt: row.published_at.toISOString(), ...(row.recipe_id ? { recipeId: row.recipe_id } : {}) }));
}
