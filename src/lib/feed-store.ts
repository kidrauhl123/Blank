import { query } from "./db";
import type { PoolClient } from "pg";
import { buildFeed, type FeedChart, type FeedDraft, type FeedPosition, type FeedPost, type FeedSubscription, type FeedTransaction } from "./feed";
import { getInvestmentOverview } from "./investments";
import { investmentValue } from "./investment-model";
import { publishRecipes } from "./feed-recipe-store";
import { judgeFeedCandidate, type FeedCandidateForJev } from "./jev";
import { collectMemoryReminders, dayLabel } from "./life-memory";
import { alertInboundRefunds } from "./fraud-store";

// 主动发帖的节奏：没有事件时每位客户一小时检查一次（只查数据库，不调模型）；发生了事件（例如一笔转账成功）时由 requestFeedCheck 打标记，下一次调度 tick 就检查。
const HEARTBEAT_INTERVAL = "1 hour";
// 每次检查最多替几条候选过 Jev，控制调用次数；剩下的留到下一次。
const JUDGED_PER_CHECK = 3;
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

// ownerId 为空是系统帖子（所有访客可见）；有值是只属于这位访客的帖子（例如用户自己说过的事的提醒）。
async function insertDraft(customerId: string, draft: FeedDraft, asOf: Date, index: number, ownerId: string | null = null) {
  const inserted = await query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,published_at,visitor_owner_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
  [customerId, draft.key, draft.kind, draft.title, draft.body, draft.source, draft.attention, JSON.stringify(draft.chart), draft.factIds, publishTime(draft, asOf, index), ownerId]);
  return inserted.rowCount ?? 0;
}

// 你说过的事到期前的提醒：标题是用户自己的话，动态里注明“你说过 · 日期”。
function memoryDraft(reminder: { id: string; text: string; dueOn: string }): FeedDraft {
  return { key: `memory:${reminder.id}:${reminder.dueOn}`, kind: "memory", title: reminder.text, body: `你说过 · ${dayLabel(reminder.dueOn)}`,
    source: "你说过", attention: true, chart: { type: "recipe", blocks: [] }, factIds: [reminder.id] };
}

// 历史回放专用：演示账户补齐过去的日子时，把模拟的历史动态按回放时间直接写入。这是历史数据，不是主动发帖，所以不过 Jev。
// 主动发帖（心跳、事件）一律走 runFeedHeartbeat，先过 Jev。
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
    published += await insertDraft(customerId, draft, asOf, index);
  }
  // 用户配方只按"现在"发布；补过去的日子时不替配方补发旧帖。配方是用户自己设定的定时卡片，不算 AI 主动发帖。
  if (Date.now() - asOf.getTime() < 15 * 60_000) published += await publishRecipes(customerId, asOf);
  await query(`INSERT INTO feed_publisher_state(customer_id,checked_at) VALUES($1,now())
    ON CONFLICT(customer_id) DO UPDATE SET checked_at=excluded.checked_at`, [customerId]);
  return published;
}

// 候选帖子：按现在的事实算出的草稿里，还没有发过的（同一去重键发过就不再是候选），以及和同类上一条标题不同的（标题相同说明事实没变）。只查数据库，不调模型。
export async function collectFeedCandidates(customerId: string, asOf = new Date()): Promise<FeedDraft[]> {
  const drafts = buildFeed(await loadFacts(customerId, asOf), asOf);
  if (!drafts.length) return [];
  const sent = new Set((await query<{ dedupe_key: string }>("SELECT dedupe_key FROM feed_posts WHERE customer_id=$1 AND dedupe_key = ANY($2::text[])", [customerId, drafts.map(draft => draft.key)])).rows.map(row => row.dedupe_key));
  const candidates: FeedDraft[] = [];
  for (const draft of drafts) {
    if (sent.has(draft.key)) continue;
    if (!draft.attention) {
      const last = await query<{ title: string }>("SELECT title FROM feed_posts WHERE customer_id=$1 AND kind=$2 AND visitor_owner_id IS NULL AND published_at<=$3 ORDER BY published_at DESC LIMIT 1", [customerId, draft.kind, asOf]);
      if (last.rows[0]?.title === draft.title) continue;
    }
    candidates.push(draft);
  }
  return candidates;
}

// 事件发生后调用（例如一笔转账成功）：只打标记，真正的检查由下一次调度 tick 做，所以事件本身不会阻塞，也不会调用模型。
export async function requestFeedCheck(customerId: string, client?: PoolClient) {
  // 新客户还没有检查过：用 epoch 表示“从未检查”，心跳的到期条件天然成立。传入 client 时和调用方同一个事务（例如定时任务的执行）。
  const run = client ? client.query.bind(client) : query;
  await run(`INSERT INTO feed_publisher_state(customer_id,checked_at,check_requested_at) VALUES($1,'epoch',now())
    ON CONFLICT(customer_id) DO UPDATE SET check_requested_at=now()`, [customerId]);
}

// 调度 tick 调用：处理“有事件请求”的客户，以及超过一小时没检查过的客户。只查数据库；候选帖子才过 Jev，通过的才发布。
// 失败的候选不会丢：这位客户的检查时间已经更新，所以下一小时的心跳会再判断一次。
export async function runFeedHeartbeat(options: { limit?: number; judge?: (candidate: FeedCandidateForJev) => Promise<{ show: boolean }>; customerIds?: string[] } = {}) {
  const { limit = 5, judge = judgeFeedCandidate, customerIds = null } = options;
  const due = await query<{ id: string }>(`SELECT c.id FROM customers c LEFT JOIN feed_publisher_state s ON s.customer_id=c.id
    WHERE c.status='ACTIVE' AND NOT ${CATCHING_UP}
      AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))
      AND (s.check_requested_at IS NOT NULL OR s.checked_at IS NULL OR s.checked_at < now() - interval '${HEARTBEAT_INTERVAL}')
    ORDER BY s.check_requested_at NULLS LAST, s.checked_at NULLS FIRST LIMIT $1`, [limit, customerIds]);
  let published = 0;
  for (const { id } of due.rows) {
    try { published += await checkCustomerFeed(id, judge); } catch { /* 单个客户失败不影响其他客户，下一小时的心跳再试 */ }
  }
  return published;
}

async function checkCustomerFeed(customerId: string, judge: (candidate: FeedCandidateForJev) => Promise<{ show: boolean }>) {
  const asOf = new Date();
  // 先清掉请求标记再检查：检查期间新来的事件会重新打标记，不会被吞掉。
  await query(`INSERT INTO feed_publisher_state(customer_id,checked_at,check_requested_at) VALUES($1,now(),NULL)
    ON CONFLICT(customer_id) DO UPDATE SET checked_at=excluded.checked_at, check_requested_at=NULL`, [customerId]);
  // 反诈的安全提醒（陌生小额退款/返利入账）不经过 Jev：每次检查都先看一遍，失败不影响动态的其他内容。
  await alertInboundRefunds(customerId, asOf).catch(() => 0);
  // 到期前的“你说过”提醒有时间限制，排在前面；其余是系统候选。两类都要过 Jev。
  const queue: Array<{ draft: FeedDraft; ownerId: string | null }> = [
    ...(await collectMemoryReminders(customerId, asOf)).map(reminder => ({ draft: memoryDraft(reminder), ownerId: reminder.ownerId })),
    ...(await collectFeedCandidates(customerId, asOf)).map(draft => ({ draft, ownerId: null })),
  ];
  const approved: Array<{ draft: FeedDraft; ownerId: string | null }> = [];
  for (const item of queue.slice(0, JUDGED_PER_CHECK)) {
    const verdict = await judge({ id: item.draft.key, kind: item.draft.kind, title: item.draft.title, body: item.draft.body, attention: item.draft.attention });
    if (verdict.show) approved.push(item);
  }
  let published = 0;
  // 和 publishFeed 一样：越重要的帖子发布时间越晚、排得越靠上。
  for (const [index, item] of [...approved].reverse().entries()) published += await insertDraft(customerId, item.draft, asOf, index, item.ownerId);
  return published;
}

// 对话里创建的定时任务每次执行后，结果作为一条只属于创建者的动态发出（和任务页里的结果是同一份）。
// 这是用户自己设定的定时任务的结果，不是 AI 主动发帖，所以不过 Jev。
export async function publishScheduleResult(client: PoolClient, input: { customerId: string; ownerId: string | null; runId: string; title: string; summary: string; source: string }) {
  if (!input.ownerId) return;
  const lines = input.summary.split("\n").map(line => line.trim()).filter(Boolean);
  await client.query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,visitor_owner_id)
    VALUES($1,$2,'schedule',$3,$4,$5,false,'{"type":"recipe","blocks":[]}'::jsonb,'{}',$6) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
  [input.customerId, `schedule-run:${input.runId}`, input.title.slice(0, 80), lines.join("\n").slice(0, 560), input.source, input.ownerId]);
}

// ownerId 是当前访客：系统帖子大家都能看到，配方帖子只给创建它的访客。
export async function listFeed(customerId: string, ownerId: string | null = null): Promise<FeedPost[]> {
  const read = () => query<{ id: string; kind: FeedPost["kind"]; title: string; body: string; source: string; attention: boolean; chart: FeedChart; fact_ids: string[]; published_at: Date; recipe_id: string | null }>(
    `SELECT id,kind,title,body,source,attention,chart,fact_ids,published_at,recipe_id FROM feed_posts
     WHERE customer_id=$1 AND (visitor_owner_id IS NULL OR visitor_owner_id=$2) ORDER BY published_at DESC,attention DESC,id LIMIT 60`, [customerId, ownerId]);
  const rows = (await read()).rows;
  // 第一次打开时还没有任何帖子：只请求一次检查，由调度 tick 经过 Jev 之后再发布，不在打开时直接发模板帖子。
  if (!rows.length) {
    const catchingUp = await query(`SELECT 1 FROM customers c WHERE c.id=$1 AND ${CATCHING_UP}`, [customerId]);
    if (!catchingUp.rowCount) await requestFeedCheck(customerId);
  }
  return rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, source: row.source, attention: row.attention,
    chart: row.chart, factIds: row.fact_ids, publishedAt: row.published_at.toISOString(), ...(row.recipe_id ? { recipeId: row.recipe_id } : {}) }));
}
