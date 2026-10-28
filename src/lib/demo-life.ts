import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { dateKey } from "./feed";
import { publishFeed } from "./feed-store";
import { addInvestmentDays, investmentFee, investmentPriceSeries, investmentRulesSchema, investmentShares } from "./investment-model";
import { SHOWCASE_PROFILE, SHOWCASE_SUBSCRIPTIONS, planLifeDay, type LifeEvent } from "./demo-life-plan";
import type { InvestmentReceipt } from "./investment-types";

// 展示账户的生活模拟：从开始日起按天补齐流水，今天的事件到点才发生。
// 每一笔都有平衡的复式分录，和预置历史数据走同一套记账方式。
const BACKFILL_DAYS = 35;
const DAY = 86_400_000;
const at = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);
const nextDate = (date: string) => dateKey(new Date(at(date, "12:00").getTime() + DAY));

type Showcase = { customerId: string; accountId: string; clearingId: string; friends: Map<string, string> };

async function loadShowcase(client: PoolClient | null): Promise<Showcase | null> {
  const run = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => client ? client.query<T>(sql, values) : query<T>(sql, values);
  const people = (await run<{ profile_key: string; customer_id: string; account_id: string }>(`SELECT d.profile_key,d.customer_id,a.id AS account_id
    FROM demo_profiles d JOIN accounts a ON a.customer_id=d.customer_id AND a.account_type='CHECKING' AND a.status='ACTIVE'`)).rows;
  const clearing = (await run<{ id: string }>("SELECT id FROM accounts WHERE system_code='DEMO_SEED_CLEARING'")).rows[0];
  const showcase = people.find(row => row.profile_key === SHOWCASE_PROFILE);
  if (!showcase || !clearing) return null;
  return { customerId: showcase.customer_id, accountId: showcase.account_id, clearingId: clearing.id,
    friends: new Map(people.filter(row => row.profile_key !== SHOWCASE_PROFILE).map(row => [row.profile_key, row.account_id])) };
}

async function exists(client: PoolClient, reference: string) {
  return Boolean((await client.query("SELECT 1 FROM ledger_transactions WHERE reference=$1", [reference])).rowCount);
}

// 一笔两边都是客户或系统账户的入账：from 减、to 加，并为涉及的客户账户各写一条流水。
async function move(client: PoolClient, input: { reference: string; time: Date; amountMinor: number; from: string; to: string; label: string;
  lines: Array<{ accountId: string; label: string; amountMinor: number; category: string; anomaly?: boolean; operationId?: string }> }) {
  const balance = await client.query<{ available_balance_minor: string; customer_id: string | null }>("SELECT available_balance_minor,customer_id FROM accounts WHERE id=$1 FOR UPDATE", [input.from]);
  // 客户余额不能为负；系统清算账户不受此限制。
  if (balance.rows[0]?.customer_id && Number(balance.rows[0].available_balance_minor) < input.amountMinor) return false;
  const ledger = await client.query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type,description,posted_at) VALUES($1,'DEMO_LIFE',$2,$3) RETURNING id", [input.reference, input.label, input.time]);
  await client.query("INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction) VALUES($1,$2,$3,'DEBIT'),($1,$4,$5,'CREDIT')",
    [ledger.rows[0].id, input.from, -input.amountMinor, input.to, input.amountMinor]);
  await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [input.from, input.amountMinor]);
  await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [input.to, input.amountMinor]);
  for (const line of input.lines) {
    await client.query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,is_anomaly,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [line.accountId, line.label, line.category, line.amountMinor, input.time, line.anomaly ?? false,
        JSON.stringify({ demo: true, source: line.operationId ? "DEMO_SEED" : "DEMO_LIFE", ledgerReference: input.reference, ...(line.operationId ? { operationId: line.operationId } : {}) })]);
  }
  return true;
}

async function applyEvent(client: PoolClient, showcase: Showcase, date: string, event: LifeEvent) {
  const time = at(date, event.time);
  if (event.kind === "invest") return invest(client, showcase, date, time, event);
  const reference = `DEMO-LIFE-${date}-${event.slot}`;
  if (await exists(client, reference)) return false;
  const self = showcase.accountId;
  if (event.kind === "friend-in" || event.kind === "friend-out") {
    const friend = showcase.friends.get(event.friend!);
    if (!friend) return false;
    const amount = Math.abs(event.amountMinor);
    return event.kind === "friend-in"
      ? move(client, { reference, time, amountMinor: amount, from: friend, to: self, label: event.label, lines: [
        { accountId: friend, label: "转账给小土豆", amountMinor: -amount, category: "转账" }, { accountId: self, label: event.label, amountMinor: amount, category: "转账" }] })
      : move(client, { reference, time, amountMinor: amount, from: self, to: friend, label: event.label, lines: [
        { accountId: self, label: event.label, amountMinor: -amount, category: "转账" }, { accountId: friend, label: `来自小土豆的转账`, amountMinor: amount, category: "转账" }] });
  }
  const incoming = event.amountMinor > 0;
  return move(client, { reference, time, amountMinor: Math.abs(event.amountMinor), from: incoming ? showcase.clearingId : self, to: incoming ? self : showcase.clearingId,
    label: event.label, lines: [{ accountId: self, label: event.label, amountMinor: event.amountMinor, category: event.category, anomaly: event.anomaly }] });
}

// 定投：和预置理财历史同样的订单、持仓、分录与流水结构，满足理财不变量检查。
async function invest(client: PoolClient, showcase: Showcase, date: string, time: Date, event: LifeEvent) {
  const product = (await client.query<{ id: string; name: string; facts: unknown; minimum_purchase_minor: string }>(
    "SELECT id,name,facts,minimum_purchase_minor FROM investment_products WHERE external_code=$1 AND is_simulated=true", [event.productCode])).rows[0];
  const custody = (await client.query<{ id: string }>("SELECT id FROM accounts WHERE system_code='INVESTMENT_CUSTODY'")).rows[0];
  const amountMinor = Math.abs(event.amountMinor);
  if (!product || !custody || amountMinor < Number(product.minimum_purchase_minor)) return false;
  const terms = investmentRulesSchema.parse(product.facts);
  const navMicros = investmentPriceSeries(terms, date).navMicros;
  const feeMinor = investmentFee(amountMinor, terms.purchaseFeeBps);
  const quantityMicro = investmentShares(amountMinor, feeMinor, navMicros);
  const operationId = `DEMO-LIFE-INV-${date}`;
  const reference = `LED-${operationId}`;
  if (await exists(client, reference)) return false;
  const positionId = randomUUID();
  const label = `${product.name} · 申购`;
  if (!await move(client, { reference, time, amountMinor, from: showcase.accountId, to: custody.id, label,
    lines: [{ accountId: showcase.accountId, label, amountMinor: -amountMinor, category: "理财", operationId }] })) return false;
  await client.query(`INSERT INTO investment_positions(id,customer_id,account_id,product_id,quantity_micro,cost_minor,purchased_on,unlocks_on,terms,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'ACTIVE',$10)`,
  [positionId, showcase.customerId, showcase.accountId, product.id, quantityMicro, amountMinor, date, addInvestmentDays(date, terms.holdingDays), JSON.stringify(terms), time]);
  const receipt: InvestmentReceipt = { operationId, status: "SUCCEEDED", side: "SUBSCRIBE", productName: product.name, amountMinor, feeMinor,
    settlementMinor: amountMinor - feeMinor, quantityMicro, navMicros, businessDate: date, positionId, ledgerReference: reference };
  await client.query(`INSERT INTO investment_orders(operation_id,customer_id,account_id,product_id,side,amount_minor,status,suitability_evidence,position_id,receipt,created_at,executed_at)
    VALUES($1,$2,$3,$4,'SUBSCRIBE',$5,'SUCCEEDED',$6::jsonb,$7,$8::jsonb,$9,$9)`, [operationId, showcase.customerId, showcase.accountId, product.id, amountMinor,
    JSON.stringify({ source: "DEMO_SEED", simulated: true, authorizationMode: "PRESET_HISTORY_NOT_LIVE_AUTH" }), positionId, JSON.stringify(receipt), time]);
  return true;
}

// 订阅到期就真的扣费，再顺延一个月。
async function chargeSubscriptions(client: PoolClient, showcase: Showcase, until: Date) {
  const due = await client.query<{ id: string; merchant_name: string; amount_minor: string; next_charge_at: Date }>(
    "SELECT id,merchant_name,amount_minor,next_charge_at FROM subscriptions WHERE customer_id=$1 AND status='ACTIVE' AND next_charge_at<=$2 ORDER BY next_charge_at FOR UPDATE",
    [showcase.customerId, until]);
  const times: Date[] = [];
  for (const sub of due.rows) {
    const reference = `DEMO-LIFE-SUB-${sub.id}-${dateKey(sub.next_charge_at)}`;
    if (!await exists(client, reference)) {
      await move(client, { reference, time: sub.next_charge_at, amountMinor: Number(sub.amount_minor), from: showcase.accountId, to: showcase.clearingId, label: sub.merchant_name,
        lines: [{ accountId: showcase.accountId, label: sub.merchant_name, amountMinor: -Number(sub.amount_minor), category: "订阅" }] });
      times.push(sub.next_charge_at);
    }
    await client.query("UPDATE subscriptions SET next_charge_at=next_charge_at + interval '1 month' WHERE id=$1", [sub.id]);
  }
  return times;
}

async function setUp(client: PoolClient, showcase: Showcase, start: string) {
  await client.query(`INSERT INTO demo_life_state(customer_id,simulated_through,original_business_date,original_subscriptions)
    VALUES($1,$2,(SELECT business_date FROM investment_simulation_clocks WHERE customer_id=$1),
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'next_charge_at',next_charge_at)),'[]') FROM subscriptions WHERE customer_id=$1))`, [showcase.customerId, start]);
  // 动态会按模拟的每一天重新发布，旧的一批（同一时刻发出）先清掉。
  await client.query("DELETE FROM feed_posts WHERE customer_id=$1", [showcase.customerId]);
  const card = (await client.query<{ id: string }>("SELECT id FROM cards WHERE customer_id=$1 ORDER BY card_name LIMIT 1", [showcase.customerId])).rows[0];
  if (!card) return;
  for (const sub of SHOWCASE_SUBSCRIPTIONS) {
    const present = await client.query("SELECT 1 FROM subscriptions WHERE customer_id=$1 AND merchant_name=$2", [showcase.customerId, sub.merchant]);
    if (present.rowCount) continue;
    await client.query("INSERT INTO subscriptions(customer_id,card_id,merchant_name,amount_minor,billing_cycle,next_charge_at) VALUES($1,$2,$3,$4,'MONTHLY',$5)",
      [showcase.customerId, card.id, sub.merchant, sub.amountMinor, at(dateKey(new Date(at(start, "12:00").getTime() + sub.dayOffset * DAY)), "07:30")]);
  }
}

// 调度器每次 tick 调用：已经过去的日子一次补齐一天并按当天时间发布动态；今天只发生已经到点的事件。
// 只在部署环境显式开启（BANKPILOT_SHOWCASE_LIFE=1），测试库里的小土豆保持预置数据不变。
export async function advanceShowcaseLife(now = new Date()) {
  if (process.env.BANKPILOT_SHOWCASE_LIFE !== "1") return null;
  const today = dateKey(now);
  const step = await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bankpilot-demo-life'))");
    const showcase = await loadShowcase(client);
    if (!showcase) return null;
    let state = (await client.query<{ through: string }>("SELECT simulated_through::text AS through FROM demo_life_state WHERE customer_id=$1", [showcase.customerId])).rows[0];
    if (!state) {
      const start = dateKey(new Date(now.getTime() - BACKFILL_DAYS * DAY));
      await setUp(client, showcase, start);
      state = { through: start };
    }
    const day = nextDate(state.through);
    if (day > today) return null;
    const live = day === today;
    const cutoff = live ? now : at(day, "23:59");
    await client.query("UPDATE investment_simulation_clocks SET business_date=GREATEST(business_date,$2::date),version=version+1 WHERE customer_id=$1", [showcase.customerId, day]);
    const checkpoints = [at(day, "07:30"), ...await chargeSubscriptions(client, showcase, cutoff)];
    for (const event of planLifeDay(day)) {
      if (at(day, event.time) > cutoff) continue;
      if (await applyEvent(client, showcase, day, event)) checkpoints.push(new Date(at(day, event.time).getTime() + 6 * 60_000));
    }
    if (!live) await client.query("UPDATE demo_life_state SET simulated_through=$2,updated_at=now() WHERE customer_id=$1", [showcase.customerId, day]);
    return { customerId: showcase.customerId, day, live, checkpoints };
  });
  if (!step) return null;
  // 补过去的日子时，按"当时"的视角发布动态：每笔事件几分钟后、每天早上 7:30 各检查一次。
  if (!step.live) for (const checkpoint of step.checkpoints.sort((a, b) => a.getTime() - b.getTime())) await publishFeed(step.customerId, checkpoint);
  return step;
}

// 撤销生活模拟写入的一切：按分录把余额扣回，删除流水、定投订单与持仓、新增的订阅和动态，恢复订阅扣费日与理财估值日期。
// 预置历史数据不受影响。
export async function resetShowcaseLife() {
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bankpilot-demo-life'))");
    const showcase = await loadShowcase(client);
    if (!showcase) return false;
    const state = (await client.query<{ original_business_date: string | null; original_subscriptions: Array<{ id: string; next_charge_at: string }> }>(
      "SELECT original_business_date::text,original_subscriptions FROM demo_life_state WHERE customer_id=$1 FOR UPDATE", [showcase.customerId])).rows[0];
    if (!state) return false;
    const life = "SELECT id FROM ledger_transactions WHERE transaction_type='DEMO_LIFE'";
    await client.query(`UPDATE accounts a SET available_balance_minor=a.available_balance_minor-t.total,version=a.version+1
      FROM (SELECT account_id,sum(amount_minor) AS total FROM ledger_entries WHERE ledger_transaction_id IN (${life}) GROUP BY account_id) t WHERE a.id=t.account_id`);
    await client.query(`DELETE FROM bank_transactions WHERE metadata->>'ledgerReference' IN (SELECT reference FROM ledger_transactions WHERE transaction_type='DEMO_LIFE')`);
    const orders = await client.query<{ position_id: string }>("DELETE FROM investment_orders WHERE operation_id LIKE 'DEMO-LIFE-INV-%' RETURNING position_id");
    await client.query("DELETE FROM investment_positions WHERE id=ANY($1::uuid[])", [orders.rows.map(row => row.position_id)]);
    await client.query(`DELETE FROM ledger_entries WHERE ledger_transaction_id IN (${life})`);
    await client.query("DELETE FROM ledger_transactions WHERE transaction_type='DEMO_LIFE'");
    await client.query("DELETE FROM subscriptions WHERE customer_id=$1 AND merchant_name=ANY($2::text[])", [showcase.customerId, SHOWCASE_SUBSCRIPTIONS.map(sub => sub.merchant)]);
    for (const sub of state.original_subscriptions) await client.query("UPDATE subscriptions SET next_charge_at=$2 WHERE id=$1", [sub.id, sub.next_charge_at]);
    if (state.original_business_date) await client.query("UPDATE investment_simulation_clocks SET business_date=$2,version=version+1 WHERE customer_id=$1", [showcase.customerId, state.original_business_date]);
    await client.query("DELETE FROM feed_posts WHERE customer_id=$1", [showcase.customerId]);
    await client.query("DELETE FROM demo_life_state WHERE customer_id=$1", [showcase.customerId]);
    return true;
  });
}
