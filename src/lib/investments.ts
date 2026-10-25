import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, withTransaction } from "./db";
import { consumeCustomerTotp } from "./auth";
import { writeAudit } from "./audit";
import { addInvestmentDays, investmentFee, investmentPriceSeries, investmentRulesSchema, investmentShares, investmentValue, type InvestmentRules, type InvestmentRisk } from "./investment-model";
import type { InvestmentOrder, InvestmentOverview, InvestmentProduct, InvestmentQuote, InvestmentReceipt } from "./investment-types";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value: string | number) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("INVESTMENT_VALUE_INVALID");
  return number;
};
type ProductRow = { id: string; external_code: string; name: string; issuer: string; risk_level: InvestmentRisk; minimum_purchase_minor: string; status: string; facts: InvestmentRules; version: number };
type PositionRow = { id: string; product_id: string; account_id: string; name: string; quantity_micro: string; cost_minor: string; purchased_on: string; unlocks_on: string; terms: InvestmentRules; status: string };
type OrderRow = { operation_id: string; status: string; expires_at: Date; quote: InvestmentQuote; receipt: InvestmentReceipt | null; authorization_fingerprint: string };
const orderView = (row: OrderRow): InvestmentOrder => ({ operationId: row.operation_id, status: row.status, expiresAt: row.expires_at.toISOString(), quote: row.quote, receipt: row.receipt });

export const investmentFiltersSchema = z.object({
  kind: z.enum(["FLEXIBLE", "HOLDING", "CLOSED"]).optional(),
  maximumRisk: z.enum(["R1", "R2", "R3", "R4", "R5"]).optional(),
  amountMinor: z.number().int().positive().max(100_000_000).optional(),
  maxHoldingDays: z.number().int().min(0).max(3650).optional(),
});
export type InvestmentFilters = z.infer<typeof investmentFiltersSchema>;

async function businessDate(customerId: string, client?: PoolClient) {
  const sql = `SELECT COALESCE((SELECT business_date FROM investment_simulation_clocks WHERE customer_id=$1),
      (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date)::text AS day`;
  const result = client ? await client.query<{ day: string }>(sql, [customerId]) : await query<{ day: string }>(sql, [customerId]);
  return result.rows[0].day;
}

async function lockCustomerClock(customerId: string, client: PoolClient) {
  const customer = await client.query("SELECT id FROM customers WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [customerId]);
  if (!customer.rowCount) throw new Error("CUSTOMER_UNAVAILABLE");
  await client.query("INSERT INTO investment_simulation_clocks(customer_id) VALUES($1) ON CONFLICT DO NOTHING", [customerId]);
  const result = await client.query<{ day: string }>("SELECT business_date::text AS day FROM investment_simulation_clocks WHERE customer_id=$1 FOR UPDATE", [customerId]);
  return result.rows[0].day;
}

function productView(row: ProductRow, day: string): InvestmentProduct {
  const rules = investmentRulesSchema.parse(row.facts);
  const { navMicros, history } = investmentPriceSeries(rules, day);
  return { id: row.id, code: row.external_code, name: row.name, issuer: row.issuer,
    kind: rules.kind, riskLevel: row.risk_level, minimumMinor: integer(row.minimum_purchase_minor),
    holdingDays: rules.holdingDays, purchaseFeeBps: rules.purchaseFeeBps, redemptionFeeBps: rules.redemptionFeeBps,
    status: row.status, navMicros, change30DaysPercent: (navMicros / history[0].navMicros - 1) * 100,
    history, simulated: true, source: "BankPilot 模拟产品及净值场景 v1" };
}

export async function listInvestmentProducts(customerId: string, filters: InvestmentFilters = {}, dayOverride?: string) {
  const input = investmentFiltersSchema.parse(filters);
  const day = dayOverride ?? await businessDate(customerId);
  const rows = await query<ProductRow>("SELECT * FROM investment_products WHERE is_simulated=true ORDER BY external_code");
  return { businessDate: day, simulated: true as const, products: rows.rows.map(row => productView(row, day)).filter(product =>
    product.status === "OPEN" && (!input.kind || product.kind === input.kind) && (!input.maximumRisk || product.riskLevel <= input.maximumRisk)
    && (!input.amountMinor || product.minimumMinor <= input.amountMinor)
    && (input.maxHoldingDays === undefined || product.holdingDays <= input.maxHoldingDays)) };
}

export async function getInvestmentOverview(customerId: string): Promise<InvestmentOverview> {
  return withTransaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const day = await businessDate(customerId, client);
    const [products, positions, assessment, cash, history] = await Promise.all([
      client.query<ProductRow>("SELECT * FROM investment_products WHERE is_simulated=true ORDER BY external_code"),
      client.query<PositionRow>(`SELECT p.*,p.purchased_on::text,p.unlocks_on::text,i.name FROM investment_positions p
        JOIN investment_products i ON i.id=p.product_id WHERE p.customer_id=$1 AND p.status='ACTIVE' ORDER BY p.created_at DESC`, [customerId]),
      client.query<{ risk_level: InvestmentRisk; expires_at: Date }>(`SELECT risk_level,expires_at FROM risk_assessments
        WHERE customer_id=$1 AND expires_at>clock_timestamp() ORDER BY assessed_at DESC,id DESC LIMIT 1`, [customerId]),
      client.query<{ total: string }>("SELECT COALESCE(sum(available_balance_minor),0)::text AS total FROM accounts WHERE customer_id=$1", [customerId]),
      client.query<{ receipt: InvestmentReceipt; executed_at: Date; source: string | null }>(`SELECT receipt,executed_at,suitability_evidence->>'source' AS source
        FROM investment_orders WHERE customer_id=$1 AND status='SUCCEEDED' AND receipt IS NOT NULL
        ORDER BY executed_at DESC,id DESC LIMIT 20`, [customerId]),
    ]);
    const holdings = positions.rows.map(row => {
      const { navMicros } = investmentPriceSeries(investmentRulesSchema.parse(row.terms), day);
      const valueMinor = investmentValue(integer(row.quantity_micro), navMicros);
      return { id: row.id, productId: row.product_id, productName: row.name, quantityMicro: integer(row.quantity_micro),
        costMinor: integer(row.cost_minor), valueMinor, profitMinor: valueMinor - integer(row.cost_minor),
        purchasedOn: row.purchased_on, unlocksOn: row.unlocks_on, redeemable: day >= row.unlocks_on };
    });
    return { businessDate: day, products: products.rows.map(row => productView(row, day)), positions: holdings,
      history: history.rows.map(row => ({ receipt: row.receipt, executedAt: row.executed_at.toISOString(), source: row.source === "DEMO_SEED" ? "DEMO_SEED" : "USER" })),
      valueMinor: holdings.reduce((sum, row) => sum + row.valueMinor, 0), profitMinor: holdings.reduce((sum, row) => sum + row.profitMinor, 0), cashMinor: integer(cash.rows[0].total),
      assessment: assessment.rows[0] ? { riskLevel: assessment.rows[0].risk_level, expiresAt: assessment.rows[0].expires_at.toISOString() } : null };
  });
}

export const investmentAssessmentSchema = z.object({ answers: z.array(z.number().int().min(1).max(3)).length(3), confirmed: z.literal(true) });
export async function saveInvestmentAssessment(customerId: string, raw: z.infer<typeof investmentAssessmentSchema>) {
  const input = investmentAssessmentSchema.parse(raw);
  return withTransaction(async client => {
    await lockCustomerClock(customerId, client);
    const score = Math.min(...input.answers);
    const result = await client.query<{ risk_level: InvestmentRisk; expires_at: Date }>(`INSERT INTO risk_assessments(customer_id,answers,score,risk_level,expires_at)
      VALUES($1,$2::jsonb,$3,$4,clock_timestamp()+interval '365 days') RETURNING risk_level,expires_at`,
    [customerId, JSON.stringify({ simulated: true, answers: input.answers }), score, `R${score}`]);
    await writeAudit({ customerId, eventType: "INVESTMENT_ASSESSMENT_SAVED", actorType: "USER", summary: "客户完成模拟风险测评", evidence: { simulated: true, riskLevel: result.rows[0].risk_level } }, client);
    return { riskLevel: result.rows[0].risk_level, expiresAt: result.rows[0].expires_at.toISOString() };
  });
}

export const investmentPrepareSchema = z.discriminatedUnion("side", [
  z.object({ side: z.literal("SUBSCRIBE"), productId: z.string().uuid(), accountId: z.string().uuid(), amountMinor: z.number().int().min(1).max(100_000_000), idempotencyKey: z.string().uuid() }),
  z.object({ side: z.literal("REDEEM"), positionId: z.string().uuid(), idempotencyKey: z.string().uuid() }),
]);
type PrepareInput = z.infer<typeof investmentPrepareSchema>;

async function buildQuote(customerId: string, input: PrepareInput, day: string, client: PoolClient): Promise<InvestmentQuote> {
  let position: PositionRow | undefined;
  if (input.side === "REDEEM") {
    const result = await client.query<PositionRow>(`SELECT p.*,p.purchased_on::text,p.unlocks_on::text,i.name FROM investment_positions p
      JOIN investment_products i ON i.id=p.product_id WHERE p.id=$1 AND p.customer_id=$2 FOR UPDATE OF p`, [input.positionId, customerId]);
    position = result.rows[0];
    if (!position || position.status !== "ACTIVE") throw new Error("INVESTMENT_POSITION_UNAVAILABLE");
    if (day < position.unlocks_on) throw new Error("INVESTMENT_LOCKED");
  }
  const product = (await client.query<ProductRow>("SELECT * FROM investment_products WHERE id=$1 AND is_simulated=true", [input.side === "SUBSCRIBE" ? input.productId : position!.product_id])).rows[0];
  if (!product || (input.side === "SUBSCRIBE" && product.status !== "OPEN")) throw new Error("INVESTMENT_PRODUCT_UNAVAILABLE");
  const rules = investmentRulesSchema.parse(position?.terms ?? product.facts);
  const accountId = input.side === "SUBSCRIBE" ? input.accountId : position!.account_id;
  const account = (await client.query<{ masked_no: string; available_balance_minor: string }>("SELECT masked_no,available_balance_minor FROM accounts WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' AND currency='CNY'", [accountId, customerId])).rows[0];
  if (!account) throw new Error("ACCOUNT_NOT_FOUND");
  let assessmentId: string | null = null;
  if (input.side === "SUBSCRIBE") {
    if (input.amountMinor < integer(product.minimum_purchase_minor)) throw new Error("INVESTMENT_MINIMUM_REQUIRED");
    if (integer(account.available_balance_minor) < input.amountMinor) throw new Error("INSUFFICIENT_FUNDS");
    const assessment = (await client.query<{ id: string; risk_level: InvestmentRisk }>(`SELECT id,risk_level FROM risk_assessments
      WHERE customer_id=$1 AND expires_at>clock_timestamp() ORDER BY assessed_at DESC,id DESC LIMIT 1`, [customerId])).rows[0];
    if (!assessment) throw new Error("INVESTMENT_ASSESSMENT_REQUIRED");
    if (assessment.risk_level < product.risk_level) throw new Error("INVESTMENT_RISK_MISMATCH");
    assessmentId = assessment.id;
  }
  const { navMicros } = investmentPriceSeries(rules, day);
  const amountMinor = input.side === "SUBSCRIBE" ? input.amountMinor : investmentValue(integer(position!.quantity_micro), navMicros);
  const feeMinor = investmentFee(amountMinor, input.side === "SUBSCRIBE" ? rules.purchaseFeeBps : rules.redemptionFeeBps);
  if (amountMinor <= feeMinor) throw new Error("INVESTMENT_VALUE_INVALID");
  return { side: input.side, customerId, productId: product.id, productName: product.name, productVersion: product.version,
    accountId, accountMaskedNo: account.masked_no, positionId: position?.id ?? null, businessDate: day, navMicros,
    quantityMicro: position ? integer(position.quantity_micro) : investmentShares(amountMinor, feeMinor, navMicros),
    amountMinor, feeMinor, settlementMinor: amountMinor - feeMinor,
    unlocksOn: position?.unlocks_on ?? addInvestmentDays(day, rules.holdingDays), riskLevel: product.risk_level,
    assessmentId, requiredAuth: input.side === "SUBSCRIBE" ? "MFA" : "CONFIRM", termsDigest: digest(rules) };
}

export async function prepareInvestment(customerId: string, raw: PrepareInput): Promise<InvestmentOrder> {
  const input = investmentPrepareSchema.parse(raw);
  return withTransaction(async client => {
    const day = await lockCustomerClock(customerId, client);
    const previous = (await client.query<OrderRow>("SELECT * FROM investment_orders WHERE customer_id=$1 AND idempotency_key=$2", [customerId, input.idempotencyKey])).rows[0];
    if (previous) {
      const quote = previous.quote;
      if (quote.side !== input.side || (input.side === "SUBSCRIBE" ? quote.productId !== input.productId || quote.accountId !== input.accountId || quote.amountMinor !== input.amountMinor : quote.positionId !== input.positionId)) throw new Error("AUTHORIZATION_MISMATCH");
      return orderView(previous);
    }
    const quote = await buildQuote(customerId, input, day, client);
    const expiry = (await client.query<{ at: Date }>("SELECT clock_timestamp()+interval '10 minutes' AS at")).rows[0].at;
    const operationId = `INV-${randomUUID()}`;
    const result = await client.query<OrderRow>(`INSERT INTO investment_orders(operation_id,customer_id,account_id,product_id,side,amount_minor,status,suitability_evidence,
      idempotency_key,position_id,quote,authorization_fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'AWAITING_AUTH',$7::jsonb,$8,$9,$10::jsonb,$11,$12) RETURNING *`,
    [operationId, customerId, quote.accountId, quote.productId, quote.side, quote.amountMinor,
      JSON.stringify({ simulated: true, assessmentId: quote.assessmentId, riskLevel: quote.riskLevel }), input.idempotencyKey, quote.positionId,
      JSON.stringify(quote), digest({ quote, expiresAt: expiry.toISOString() }), expiry]);
    await writeAudit({ customerId, operationId, eventType: "INVESTMENT_PREPARED", actorType: "BANK_CORE", summary: "模拟理财草稿已准备，资金尚未变动",
      evidence: { side: quote.side, amountMinor: quote.amountMinor, requiredAuth: quote.requiredAuth, simulated: true } }, client);
    return orderView(result.rows[0]);
  });
}

export async function getInvestmentOrder(customerId: string, operationId: string) {
  const row = (await query<OrderRow>("SELECT * FROM investment_orders WHERE operation_id=$1 AND customer_id=$2 AND quote IS NOT NULL", [operationId, customerId])).rows[0];
  if (!row) throw new Error("OPERATION_NOT_FOUND");
  return orderView(row);
}

export async function commitInvestment(customerId: string, operationId: string, code?: string) {
  return withTransaction(async client => {
    const day = await lockCustomerClock(customerId, client);
    const row = (await client.query<OrderRow & { idempotency_key: string; expired: boolean }>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM investment_orders
      WHERE operation_id=$1 AND customer_id=$2 AND quote IS NOT NULL FOR UPDATE`, [operationId, customerId])).rows[0];
    if (!row) throw new Error("OPERATION_NOT_FOUND");
    if (row.status === "SUCCEEDED" && row.receipt) return { receipt: row.receipt };
    if (row.status !== "AWAITING_AUTH") throw new Error("OPERATION_NOT_EXECUTABLE");
    if (row.expired) throw new Error("AUTH_EXPIRED");
    const saved = row.quote;
    const input: PrepareInput = saved.side === "SUBSCRIBE"
      ? { side: "SUBSCRIBE", productId: saved.productId, accountId: saved.accountId, amountMinor: saved.amountMinor, idempotencyKey: row.idempotency_key }
      : { side: "REDEEM", positionId: saved.positionId!, idempotencyKey: row.idempotency_key };
    const quote = await buildQuote(customerId, input, day, client);
    if (digest({ quote, expiresAt: row.expires_at.toISOString() }) !== row.authorization_fingerprint) throw new Error("AUTHORIZATION_MISMATCH");
    if (quote.requiredAuth === "MFA") {
      if (!code || !/^\d{6}$/.test(code)) return { authError: "AUTH_REQUIRED" as const };
      const outcome = await consumeCustomerTotp(customerId, code, client);
      if (outcome !== "VERIFIED") return { authError: outcome === "LOCKED" ? "AUTH_FUSE_ACTIVE" as const : "AUTH_INVALID" as const };
    }
    await client.query(`INSERT INTO accounts(customer_id,name,account_type,masked_no,currency,available_balance_minor,status,system_code)
      VALUES(NULL,'模拟理财托管','SETTLEMENT','INTERNAL','CNY',0,'ACTIVE','INVESTMENT_CUSTODY')
      ON CONFLICT(system_code) WHERE system_code IS NOT NULL DO NOTHING`);
    const custody = (await client.query<{ id: string }>("SELECT id FROM accounts WHERE system_code='INVESTMENT_CUSTODY'")).rows[0].id;
    const accounts = await client.query<{ id: string; customer_id: string | null; status: string; currency: string; available_balance_minor: string }>("SELECT id,customer_id,status,currency,available_balance_minor FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[quote.accountId, custody]]);
    const account = accounts.rows.find(item => item.id === quote.accountId);
    if (!account || account.customer_id !== customerId || account.status !== "ACTIVE" || account.currency !== "CNY") throw new Error("ACCOUNT_NOT_FOUND");
    if (quote.side === "SUBSCRIBE" && integer(account.available_balance_minor) < quote.amountMinor) throw new Error("INSUFFICIENT_FUNDS");
    let positionId = quote.positionId;
    if (quote.side === "SUBSCRIBE") {
      const product = (await client.query<ProductRow>("SELECT * FROM investment_products WHERE id=$1", [quote.productId])).rows[0];
      const position = await client.query<{ id: string }>(`INSERT INTO investment_positions(customer_id,account_id,product_id,quantity_micro,cost_minor,purchased_on,unlocks_on,terms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
      [customerId, quote.accountId, quote.productId, quote.quantityMicro, quote.amountMinor, day, quote.unlocksOn, JSON.stringify(product.facts)]);
      positionId = position.rows[0].id;
    } else {
      await client.query("UPDATE investment_positions SET status='REDEEMED' WHERE id=$1 AND customer_id=$2", [positionId, customerId]);
    }
    const delta = quote.side === "SUBSCRIBE" ? -quote.amountMinor : quote.settlementMinor;
    const reference = `LED-${operationId}`;
    const label = `${quote.productName} · 模拟${quote.side === "SUBSCRIBE" ? "申购" : "赎回"}`;
    const ledger = (await client.query<{ id: string }>(`INSERT INTO ledger_transactions(reference,transaction_type,description)
      VALUES($1,$2,$3) RETURNING id`, [reference, `INVESTMENT_${quote.side}`, label])).rows[0];
    await client.query(`INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction)
      VALUES($1,$2,$3,$4),($1,$5,$6,$7)`, [ledger.id, quote.accountId, delta, delta < 0 ? "DEBIT" : "CREDIT", custody, -delta, delta < 0 ? "CREDIT" : "DEBIT"]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [quote.accountId, delta]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [custody, delta]);
    await client.query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,metadata)
      VALUES($1,$2,'模拟理财',$3,(SELECT posted_at FROM ledger_transactions WHERE id=$4),$5::jsonb)`, [quote.accountId, label, delta, ledger.id, JSON.stringify({ operationId, simulated: true, businessDate: day, ledgerReference: reference })]);
    const receipt: InvestmentReceipt = { operationId, status: "SUCCEEDED", side: quote.side, productName: quote.productName,
      amountMinor: quote.amountMinor, feeMinor: quote.feeMinor, settlementMinor: quote.settlementMinor,
      quantityMicro: quote.quantityMicro, navMicros: quote.navMicros, businessDate: day, positionId: positionId!, ledgerReference: reference };
    await client.query("UPDATE investment_orders SET status='SUCCEEDED',executed_at=(SELECT posted_at FROM ledger_transactions WHERE id=$4),position_id=$2,receipt=$3::jsonb WHERE operation_id=$1", [operationId, positionId, JSON.stringify(receipt), ledger.id]);
    await writeAudit({ customerId, operationId, eventType: "INVESTMENT_POSTED", actorType: "BANK_CORE", summary: "模拟理财操作已记入双分录账本", evidence: { ...receipt, simulated: true } }, client);
    return { receipt };
  });
}

export async function cancelInvestment(customerId: string, operationId: string) {
  return withTransaction(async client => {
    await lockCustomerClock(customerId, client);
    const row = (await client.query<OrderRow>("SELECT * FROM investment_orders WHERE operation_id=$1 AND customer_id=$2 AND quote IS NOT NULL FOR UPDATE", [operationId, customerId])).rows[0];
    if (!row) throw new Error("OPERATION_NOT_FOUND");
    if (row.status === "SUCCEEDED") throw new Error("OPERATION_NOT_EXECUTABLE");
    await client.query("UPDATE investment_orders SET status='CANCELLED' WHERE operation_id=$1", [operationId]);
    await writeAudit({ customerId, operationId, eventType: "INVESTMENT_CANCELLED", actorType: "USER", summary: "客户取消模拟理财草稿，资金未变动" }, client);
    return { status: "CANCELLED" as const };
  });
}

export async function advanceInvestmentClock(customerId: string, days: number, expectedDate: string) {
  if (![1, 30, 90].includes(days)) throw new Error("INVESTMENT_DATE_INVALID");
  return withTransaction(async client => {
    const current = await lockCustomerClock(customerId, client);
    if (current !== expectedDate) throw new Error("INVESTMENT_DATE_CHANGED");
    const next = addInvestmentDays(current, days);
    if (next > "2045-12-31") throw new Error("INVESTMENT_DATE_INVALID");
    await client.query("UPDATE investment_simulation_clocks SET business_date=$2,version=version+1 WHERE customer_id=$1", [customerId, next]);
    await client.query("UPDATE investment_orders SET status='CANCELLED' WHERE customer_id=$1 AND status='AWAITING_AUTH' AND quote IS NOT NULL", [customerId]);
    await writeAudit({ customerId, eventType: "INVESTMENT_CLOCK_ADVANCED", actorType: "USER", summary: "客户推进模拟理财日期，旧报价作废", evidence: { from: current, to: next, days, simulated: true } }, client);
    return { businessDate: next };
  });
}
