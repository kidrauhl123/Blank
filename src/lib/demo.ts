import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AuthError, createSession } from "./auth";
import { query, withTransaction } from "./db";
import { DEMO_PROFILES } from "./demo-catalog";
import { ensureVisitorMemoryToken } from "./visitor-memory";

export async function isDemoCustomer(customerId: string) {
  return Boolean((await query("SELECT 1 FROM demo_profiles WHERE customer_id=$1", [customerId])).rowCount);
}
const ago = (days: number) => new Date(Date.now() - days * 86400000);
type Person = { id: string; accountId: string; name: string; phone: string; key: string };

// Every fictional balance change also has a balanced journal entry. Seeding
// never resets an existing profile, and never touches other customers.
async function post(client: PoolClient, accountId: string, counterparty: string, amount: number, label: string, category: string, days: number, reference: string, anomaly = false) {
  const time = ago(days);
  const ledger = await client.query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type,description,posted_at) VALUES($1,'DEMO_HISTORY',$2,$3) RETURNING id", [reference, label, time]);
  await client.query("INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction) VALUES($1,$2,$3,$4),($1,$5,$6,$7)", [ledger.rows[0].id, accountId, amount, amount > 0 ? "CREDIT" : "DEBIT", counterparty, -amount, amount > 0 ? "DEBIT" : "CREDIT"]);
  await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [accountId, amount]);
  await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [counterparty, amount]);
  await client.query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,is_anomaly,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", [accountId, label, category, amount, time, anomaly, JSON.stringify({ demo: true, source: "DEMO_SEED", ledgerReference: reference })]);
}

export async function ensureDemoProfiles() {
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bankpilot-demo-seed-v1'))");
    const existing = await client.query<{ profile_key: string }>("SELECT profile_key FROM demo_profiles");
    if (existing.rowCount === DEMO_PROFILES.length && DEMO_PROFILES.every((profile) => existing.rows.some((row) => row.profile_key === profile.key))) return;
    // All profiles are created atomically. Partial/manual mappings are rejected.
    if (existing.rowCount) throw new Error("DEMO_SEED_INCOMPLETE");
    const clearing = await client.query<{ id: string }>(`INSERT INTO accounts(name,account_type,masked_no,system_code) VALUES('模拟数据对手账户','SETTLEMENT','DEMO INTERNAL','DEMO_SEED_CLEARING') RETURNING id`);
    const people: Person[] = [];
    for (const [i, profile] of DEMO_PROFILES.entries()) {
      const id = randomUUID(), accountId = randomUUID();
      await client.query("INSERT INTO customers(id,display_name,phone,risk_profile) VALUES($1,$2,$3,'BALANCED')", [id, profile.name, profile.phone]);
      // Unusable random credentials preserve the identity schema; there is no
      // public shared password and these values never enter the browser.
      await client.query("INSERT INTO auth_credentials(customer_id,password_salt,password_hash) VALUES($1,$2,$3)", [id, randomBytes(16).toString("hex"), randomBytes(64).toString("hex")]);
      await client.query("INSERT INTO accounts(id,customer_id,name,account_type,account_no,masked_no) VALUES($1,$2,'活期账户','CHECKING',$3,$4)", [accountId, id, `990062220200000${i + 1}`, `•• ${String(1001 + i)}`]);
      await client.query("INSERT INTO demo_profiles(profile_key,customer_id) VALUES($1,$2)", [profile.key, id]);
      const person = { id, accountId, name: profile.name, phone: profile.phone, key: profile.key };
      people.push(person);
      await post(client, accountId, clearing.rows[0].id, profile.initialMinor, "模拟期初资金", "入金", 65, `DEMO-${profile.key}-OPENING`);
      const items: Array<[string, string, number, number, boolean?]> = [
        [profile.key === "chestnut" ? "生活费（模拟）" : profile.key === "apple" ? "店铺经营收入（模拟）" : "工资到账（模拟）", "收入", profile.salaryMinor, 5],
        ["星河咖啡（模拟）", "餐饮", -3200 - i * 200, 1], ["邻里超市（模拟）", "购物", -18650 - i * 1300, 2],
        ["城市地铁（模拟）", "交通", -600, 3], ["午餐小馆（模拟）", "餐饮", -5800, 4],
        ["云盘会员（模拟）", "订阅", -1800, 6], ["音乐会员（模拟）", "订阅", -1500, 9],
        ["水电缴费（模拟）", "生活缴费", -23600 - i * 500, 12], ["学习书店（模拟）", "教育", -8900, 16],
        ["周末出行（模拟）", "交通", -12500 - i * 600, 20], ["邻里超市（模拟）", "购物", -22100, 35],
        ["上月餐饮（模拟）", "餐饮", -6800, 42], ["上月收入（模拟）", "收入", profile.salaryMinor, 45],
        [profile.key === "orange" ? "境外重复扣费（模拟）" : "陌生商户扣费（模拟）", "购物", -399900, 7, true],
      ];
      for (const [j, item] of items.entries()) await post(client, accountId, clearing.rows[0].id, item[2], item[0], item[1], item[3], `DEMO-${profile.key}-${j}`, item[4]);
      const card = await client.query<{ id: string }>("INSERT INTO cards(customer_id,account_id,card_name,masked_no,card_type,daily_limit_minor) VALUES($1,$2,'日常消费卡',$3,'VIRTUAL',100000) RETURNING id", [id, accountId, `•••• ${4101 + i}`]);
      await client.query("INSERT INTO cards(customer_id,account_id,card_name,masked_no,card_type,daily_limit_minor,overseas_enabled) VALUES($1,$2,'旅行备用卡',$3,'VIRTUAL',200000,true)", [id, accountId, `•••• ${8101 + i}`]);
      for (const [merchant, amount, day] of [["云盘会员（模拟）", 1800, 8], ["音乐会员（模拟）", 1500, 16]] as const) {
        await client.query("INSERT INTO subscriptions(customer_id,card_id,merchant_name,amount_minor,billing_cycle,next_charge_at) VALUES($1,$2,$3,$4,'MONTHLY',$5)", [id, card.rows[0].id, merchant, amount, ago(-day)]);
      }
      await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary,evidence) VALUES($1,'DEMO_DATA_SEEDED','SYSTEM','创建比赛模拟用户及历史数据', $2::jsonb)", [id, JSON.stringify({ demo: true, source: "DEMO_SEED", profileKey: profile.key })]);
    }
    // A ring of genuine sandbox transfer records: every person has one sent
    // and one received transfer, linked to beneficiaries and a balanced ledger.
    for (const [i, from] of people.entries()) {
      const to = people[(i + 1) % people.length], amount = [8800, 16800, 25000, 60000, 12000][i], time = ago(3 + i * 7);
      const operationId = `DEMO-TRF-${from.key}-${to.key}`;
      const beneficiary = await client.query<{ id: string }>("INSERT INTO beneficiaries(customer_id,name,phone,bank_name,masked_account,settlement_account_id,recipient_customer_id,trusted) VALUES($1,$2,$3,'BankPilot',$4,$5,$6,true) RETURNING id", [from.id, to.name, to.phone, `•• ${1001 + (i + 1) % people.length}`, to.accountId, to.id]);
      const transfer = await client.query<{ id: string }>(`INSERT INTO transfers(operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,note,risk_level,required_auth,status,authorization_fingerprint,prepared_at,confirmed_at,executed_at) VALUES($1,$1,$2,$3,$4,$5,'模拟朋友间转账','YELLOW','CONFIRM','SUCCEEDED',$6,$7,$7,$7) RETURNING id`, [operationId, from.id, from.accountId, beneficiary.rows[0].id, amount, createHash("sha256").update(operationId).digest("hex"), time]);
      const ledger = await client.query<{ id: string }>("INSERT INTO ledger_transactions(reference,transfer_id,transaction_type,description,posted_at) VALUES($1,$2,'TRANSFER','模拟历史转账',$3) RETURNING id", [`LED-${operationId}`, transfer.rows[0].id, time]);
      await client.query("INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction) VALUES($1,$2,$3,'DEBIT'),($1,$4,$5,'CREDIT')", [ledger.rows[0].id, from.accountId, -amount, to.accountId, amount]);
      await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [from.accountId, -amount]);
      await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [to.accountId, amount]);
      for (const [person, label, value] of [[from, `转账给${to.name}`, -amount], [to, `来自${from.name}的转账`, amount]] as const) await client.query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,metadata) VALUES($1,$2,'转账',$3,$4,$5::jsonb)", [person.accountId, label, value, time, JSON.stringify({ demo: true, source: "DEMO_SEED", operationId, ledgerReference: `LED-${operationId}` })]);
    }
  });
}

export async function loginDemoProfile(input: { profileKey: string; previousToken?: string; previousMemoryToken?: string; userAgent?: string | null }) {
  // Only the published fictional identities are selectable, never a customer UUID.
  if (!DEMO_PROFILES.some((profile) => profile.key === input.profileKey)) throw new AuthError("DEMO_PROFILE_NOT_FOUND", 404);
  await ensureDemoProfiles();
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; display_name: string; phone: string }>(
      "SELECT c.id,c.display_name,c.phone FROM demo_profiles d JOIN customers c ON c.id=d.customer_id WHERE d.profile_key=$1 AND c.status='ACTIVE'", [input.profileKey],
    );
    const customer = result.rows[0];
    if (!customer) throw new AuthError("CUSTOMER_UNAVAILABLE", 403);
    if (input.previousToken) await client.query("UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [createHash("sha256").update(input.previousToken).digest("hex")]);
    const session = await createSession(customer.id, input.userAgent, client);
    const memoryToken = await ensureVisitorMemoryToken(input.previousMemoryToken, client);
    await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary,evidence) VALUES($1,'DEMO_SESSION_STARTED','USER','选择比赛模拟用户',$2::jsonb)", [customer.id, JSON.stringify({ demo: true, profileKey: input.profileKey })]);
    return { customer, ...session, memoryToken };
  });
}
