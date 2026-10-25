import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { DEMO_PROFILES } from "./demo-catalog";
import DEMO_MERCHANTS from "./demo-merchant-catalog.json";
import { buildDemoInvestmentPlan, type DemoInvestmentProduct } from "./demo-investment-plan";
import type { InvestmentReceipt } from "./investment-types";
import { writeAudit } from "./audit";

const at = (date: string, hour = 12) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00+08:00`);
type Lot = ReturnType<typeof buildDemoInvestmentPlan>["closed"];

async function post(client: PoolClient, customerId: string, accountId: string, counterparty: string, amount: number, name: string, day: string, reference: string, operationId?: string) {
  const time = at(day, operationId?.endsWith("SELL") ? 11 : operationId?.endsWith("-past-BUY") ? 10 : operationId ? 12 : 9);
  const ledger = (await client.query<{ id: string }>(`INSERT INTO ledger_transactions(reference,transaction_type,description,posted_at)
    VALUES($1,'DEMO_INVESTMENT_HISTORY',$2,$3) RETURNING id`, [reference, name, time])).rows[0].id;
  await client.query(`INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction)
    VALUES($1,$2,$3,$4),($1,$5,$6,$7)`, [ledger, accountId, amount, amount > 0 ? "CREDIT" : "DEBIT", counterparty, -amount, amount > 0 ? "DEBIT" : "CREDIT"]);
  await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [accountId, amount]);
  await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [counterparty, amount]);
  await client.query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,metadata)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [accountId, name, operationId ? "理财" : "入金", amount, time,
    JSON.stringify({ demo: true, source: "DEMO_SEED", customerId, operationId, ledgerReference: reference })]);
}

async function seedProfile(profileKey: (typeof DEMO_PROFILES)[number]["key"], customerId: string) {
  return withTransaction(async client => {
    await client.query("SELECT id FROM customers WHERE id=$1 FOR NO KEY UPDATE", [customerId]);
    const mapping = (await client.query<{ investment_seeded_at: Date | null }>("SELECT investment_seeded_at FROM demo_profiles WHERE profile_key=$1 AND customer_id=$2 FOR UPDATE", [profileKey, customerId])).rows[0];
    if (!mapping || mapping.investment_seeded_at) return;
    const account = (await client.query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=$1 AND account_type='CHECKING' AND status='ACTIVE' AND currency='CNY' ORDER BY created_at,id LIMIT 1", [customerId])).rows[0];
    if (!account) throw new Error("DEMO_INVESTMENT_ACCOUNT_MISSING");
    const products = (await client.query<DemoInvestmentProduct>("SELECT * FROM investment_products WHERE is_simulated=true")).rows;
    await client.query("INSERT INTO investment_simulation_clocks(customer_id) VALUES($1) ON CONFLICT DO NOTHING", [customerId]);
    const day = (await client.query<{ day: string }>("SELECT business_date::text AS day FROM investment_simulation_clocks WHERE customer_id=$1 FOR UPDATE", [customerId])).rows[0].day;
    const plan = buildDemoInvestmentPlan(profileKey, products, day);
    await client.query(`INSERT INTO accounts(customer_id,name,account_type,masked_no,currency,available_balance_minor,status,system_code)
      VALUES(NULL,'理财托管','SETTLEMENT','INTERNAL','CNY',0,'ACTIVE','INVESTMENT_CUSTODY')
      ON CONFLICT(system_code) WHERE system_code IS NOT NULL DO NOTHING`);
    const system = (await client.query<{ id: string; system_code: string }>("SELECT id,system_code FROM accounts WHERE system_code IN ('INVESTMENT_CUSTODY','DEMO_SEED_CLEARING')")).rows;
    const custody = system.find(row => row.system_code === "INVESTMENT_CUSTODY")?.id;
    const clearing = system.find(row => row.system_code === "DEMO_SEED_CLEARING")?.id;
    if (!custody || !clearing) throw new Error("DEMO_INVESTMENT_ACCOUNT_MISSING");
    const locked = (await client.query<{ id: string; customer_id: string | null; status: string }>("SELECT id,customer_id,status FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[account.id, custody, clearing]])).rows;
    if (!locked.some(row => row.id === account.id && row.customer_id === customerId && row.status === "ACTIVE")) throw new Error("DEMO_INVESTMENT_ACCOUNT_MISSING");
    await post(client, customerId, account.id, clearing, plan.fundingMinor, DEMO_MERCHANTS[profileKey].sourceAccount, plan.fundedOn, `DEMO-INV-${profileKey}-CAPITAL`);

    const buy = async (lot: Lot) => {
      const positionId = randomUUID();
      const time = at(lot.purchasedOn, lot.key === "past" ? 10 : 12);
      await client.query(`INSERT INTO investment_positions(id,customer_id,account_id,product_id,quantity_micro,cost_minor,purchased_on,unlocks_on,terms,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'ACTIVE',$10)`,
      [positionId, customerId, account.id, lot.product.id, lot.quantityMicro, lot.amountMinor, lot.purchasedOn, lot.unlocksOn, JSON.stringify(lot.terms), time]);
      const operationId = `DEMO-INV-${profileKey}-${lot.key}-BUY`;
      await post(client, customerId, account.id, custody, -lot.amountMinor, `${lot.product.name} · 申购`, lot.purchasedOn, `LED-${operationId}`, operationId);
      const receipt: InvestmentReceipt = { operationId, status: "SUCCEEDED", side: "SUBSCRIBE", productName: lot.product.name, amountMinor: lot.amountMinor,
        feeMinor: lot.feeMinor, settlementMinor: lot.amountMinor - lot.feeMinor, quantityMicro: lot.quantityMicro, navMicros: lot.navMicros,
        businessDate: lot.purchasedOn, positionId, ledgerReference: `LED-${operationId}` };
      await insertOrder(client, customerId, account.id, lot, receipt, time);
      return positionId;
    };
    const closedPositionId = await buy(plan.closed);
    const operationId = `DEMO-INV-${profileKey}-past-SELL`;
    await post(client, customerId, account.id, custody, plan.redemption.settlementMinor, `${plan.closed.product.name} · 赎回`, plan.redemption.redeemedOn, `LED-${operationId}`, operationId);
    const redemption: InvestmentReceipt = { operationId, status: "SUCCEEDED", side: "REDEEM", productName: plan.closed.product.name,
      amountMinor: plan.redemption.amountMinor, feeMinor: plan.redemption.feeMinor, settlementMinor: plan.redemption.settlementMinor,
      quantityMicro: plan.closed.quantityMicro, navMicros: plan.redemption.navMicros, businessDate: plan.redemption.redeemedOn,
      positionId: closedPositionId, ledgerReference: `LED-${operationId}` };
    await insertOrder(client, customerId, account.id, plan.closed, redemption, at(plan.redemption.redeemedOn, 11));
    await client.query("UPDATE investment_positions SET status='REDEEMED' WHERE id=$1", [closedPositionId]);
    for (const lot of [...plan.holdings].sort((a, b) => a.purchasedOn.localeCompare(b.purchasedOn))) await buy(lot);
    await client.query("UPDATE demo_profiles SET investment_seeded_at=clock_timestamp() WHERE profile_key=$1 AND customer_id=$2", [profileKey, customerId]);
    await writeAudit({ customerId, eventType: "DEMO_INVESTMENTS_SEEDED", actorType: "SYSTEM", summary: "补齐预置理财持仓与历史交易",
      evidence: { source: "DEMO_SEED", profileKey, currentPositions: 2, redeemedPositions: 1, cashDeltaMinor: 0, fundingMinor: plan.fundingMinor } }, client);
  });
}

async function insertOrder(client: PoolClient, customerId: string, accountId: string, lot: Lot, receipt: InvestmentReceipt, time: Date) {
  await client.query(`INSERT INTO investment_orders(operation_id,customer_id,account_id,product_id,side,amount_minor,status,suitability_evidence,position_id,receipt,created_at,executed_at)
    VALUES($1,$2,$3,$4,$5,$6,'SUCCEEDED',$7::jsonb,$8,$9::jsonb,$10,$10)`, [receipt.operationId, customerId, accountId, lot.product.id, receipt.side,
    receipt.amountMinor, JSON.stringify({ source: "DEMO_SEED", simulated: true, authorizationMode: "PRESET_HISTORY_NOT_LIVE_AUTH" }), receipt.positionId, JSON.stringify(receipt), time]);
}

export async function ensureDemoInvestmentHistory() {
  const rows = (await query<{ profile_key: string; customer_id: string }>("SELECT profile_key,customer_id FROM demo_profiles WHERE investment_seeded_at IS NULL ORDER BY customer_id")).rows;
  for (const row of rows) {
    const profile = DEMO_PROFILES.find(profile => profile.key === row.profile_key);
    if (profile) await seedProfile(profile.key, row.customer_id);
  }
}
