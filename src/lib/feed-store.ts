import { query } from "./db";
import { buildFeed, type FeedChart, type FeedPosition, type FeedPost, type FeedSubscription, type FeedTransaction } from "./feed";
import { getInvestmentOverview } from "./investments";
import { investmentValue } from "./investment-model";

const PUBLISH_INTERVAL = "10 minutes";

async function loadFacts(customerId: string) {
  const [transactions, subscriptions, investments] = await Promise.all([
    query<Omit<FeedTransaction, "amount_minor" | "occurred_at"> & { amount_minor: string; occurred_at: Date }>(
      `SELECT bt.id,bt.merchant_name,bt.category,bt.amount_minor,bt.occurred_at,bt.is_anomaly
       FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       WHERE a.customer_id=$1 AND bt.occurred_at >= now() - interval '60 days'
       ORDER BY bt.occurred_at DESC LIMIT 500`,
      [customerId],
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
export async function publishFeed(customerId: string) {
  const drafts = buildFeed(await loadFacts(customerId));
  let published = 0;
  // 列表按发布时间倒序，倒着插入让同一批里最重要的帖子排在最上面。
  for (const draft of [...drafts].reverse()) {
    const inserted = await query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
    [customerId, draft.key, draft.kind, draft.title, draft.body, draft.source, draft.attention, JSON.stringify(draft.chart), draft.factIds]);
    published += inserted.rowCount ?? 0;
  }
  await query(`INSERT INTO feed_publisher_state(customer_id,checked_at) VALUES($1,now())
    ON CONFLICT(customer_id) DO UPDATE SET checked_at=excluded.checked_at`, [customerId]);
  return published;
}

// 调度器每次 tick 最多替几位客户检查一次，每位客户十分钟内只检查一次。
export async function publishDueFeeds(limit = 5) {
  const due = await query<{ id: string }>(`SELECT c.id FROM customers c LEFT JOIN feed_publisher_state s ON s.customer_id=c.id
    WHERE c.status='ACTIVE' AND (s.checked_at IS NULL OR s.checked_at < now() - interval '${PUBLISH_INTERVAL}')
    ORDER BY s.checked_at NULLS FIRST LIMIT $1`, [limit]);
  let published = 0;
  for (const { id } of due.rows) {
    try { published += await publishFeed(id); } catch { /* 单个客户失败不影响其他客户，下一轮再试 */ }
  }
  return published;
}

export async function listFeed(customerId: string): Promise<FeedPost[]> {
  const read = () => query<{ id: string; kind: FeedPost["kind"]; title: string; body: string; source: string; attention: boolean; chart: FeedChart; fact_ids: string[]; published_at: Date }>(
    `SELECT id,kind,title,body,source,attention,chart,fact_ids,published_at FROM feed_posts
     WHERE customer_id=$1 ORDER BY published_at DESC,attention DESC,id LIMIT 30`, [customerId]);
  let rows = (await read()).rows;
  // 第一次打开时还没有任何帖子，就地发布一次，不必等后台下一轮。
  if (!rows.length) { await publishFeed(customerId); rows = (await read()).rows; }
  return rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, source: row.source, attention: row.attention,
    chart: row.chart, factIds: row.fact_ids, publishedAt: row.published_at.toISOString() }));
}
