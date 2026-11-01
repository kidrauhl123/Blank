import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { registerCustomer } from "./auth";
import { commitTransfer, prepareTransfer } from "./bank-core";
import { query } from "./db";
import { FraudHoldError, holdFraudTransfer } from "./fraud-store";

const PASSWORD = "Test-only-123456";
// 测试库可能同时跑着别的测试，手机号用单独的前缀。
const RUN = String(randomInt(0, 1000)).padStart(3, "0");
let phoneSeq = 0;
const testPhone = () => `1993${RUN}${String(++phoneSeq).padStart(4, "0")}`;
const suffix = () => randomUUID().slice(0, 6);
// 北京时间深夜本身就会因为“深夜”暂缓；只测“连续转账”的用例在深夜跳过，避免和另一条规则混在一起。
const beijingHour = new Date(Date.now() + 8 * 3_600_000).getUTCHours();
const nightNow = beijingHour >= 23 || beijingHour < 7;

const created = { customers: [] as string[], owners: [] as string[] };
type Party = { id: string; name: string; phone: string; accountId: string };

async function newCustomer(displayName: string): Promise<Party> {
  const phone = testPhone();
  const identity = await registerCustomer({ displayName, phone, password: PASSWORD });
  const id = identity.customer.id;
  created.customers.push(id);
  const account = (await query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=$1 AND account_type='CHECKING'", [id])).rows[0];
  return { id, name: displayName, phone, accountId: account.id };
}
async function newOwner() {
  const id = randomUUID();
  await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [id, randomBytes(32).toString("hex")]);
  created.owners.push(id);
  return id;
}
async function setBalance(accountId: string, minor: number) {
  await query("UPDATE accounts SET available_balance_minor=$2 WHERE id=$1", [accountId, minor]);
}
async function balanceOf(accountId: string) {
  return Number((await query<{ balance: string }>("SELECT available_balance_minor AS balance FROM accounts WHERE id=$1", [accountId])).rows[0].balance);
}
// 一笔以前已经成功转过的钱：让收款人变成“不是第一次”的人（老朋友），不经过转账流程。
async function paidBefore(payer: Party, payee: Party) {
  const beneficiary = (await query<{ id: string }>(`INSERT INTO beneficiaries(customer_id,name,bank_name,masked_account,settlement_account_id,recipient_customer_id)
    VALUES($1,$2,'Blank','•• 0000',$3,$4) ON CONFLICT (customer_id,settlement_account_id) DO UPDATE SET name=excluded.name RETURNING id`,
  [payer.id, payee.name, payee.accountId, payee.id])).rows[0];
  await query(`INSERT INTO transfers(operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,risk_level,required_auth,status,authorization_fingerprint,executed_at)
    VALUES($1,$2,$3,$4,$5,1000,'GREEN','NONE','SUCCEEDED','test-fixture',now() - interval '3 days')`,
  [`FRAUD-${randomUUID()}`, randomUUID(), payer.id, payer.accountId, beneficiary.id]);
}
// 用户在 App 里说过的一句话（语音或打字都可能）：只用来看最近一小时里有没有话术。
async function chat(customerId: string, text: string, createdAt: Date) {
  await query("INSERT INTO app_agent_runs(id,customer_id,session_hash,start_text,start_source,created_at) VALUES($1,$2,'test-session',$3,'typed',$4)",
    [randomUUID(), customerId, text, createdAt]);
}
const draft = (payer: Party, payee: Party, amountMinor: number, owner: string | null) =>
  prepareTransfer(payer.id, { fromAccountId: payer.accountId, recipient: payee.phone, amountMinor }, { ownerId: owner });

async function cleanup() {
  const customers = created.customers;
  if (customers.length > 0) {
    const ourAccounts = "SELECT id FROM accounts WHERE customer_id=ANY($1::uuid[])";
    const ledgerIds = (await query<{ id: string }>(`SELECT DISTINCT ledger_transaction_id AS id FROM ledger_entries WHERE account_id IN (${ourAccounts})`, [customers])).rows.map(row => row.id);
    await query("DELETE FROM ledger_entries WHERE ledger_transaction_id=ANY($1::uuid[])", [ledgerIds]);
    await query("DELETE FROM ledger_transactions WHERE id=ANY($1::uuid[])", [ledgerIds]);
    await query(`DELETE FROM bank_transactions WHERE account_id IN (${ourAccounts})`, [customers]);
    await query("DELETE FROM policy_decisions WHERE operation_id IN (SELECT operation_id FROM transfers WHERE customer_id=ANY($1::uuid[]))", [customers]);
    await query("DELETE FROM authorization_challenges WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM transfers WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM channel_outbox WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM app_agent_runs WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM beneficiaries WHERE customer_id=ANY($1::uuid[]) OR recipient_customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
  }
  if (created.owners.length > 0) await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [created.owners]);
}

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("反诈守护：发起转账时的暂缓（真实数据库）", () => {
  afterAll(cleanup);

  it("最近一小时的对话里出现“安全账户”：转账被暂缓、风险升到红色、要求强验证；资金不动；动态里有记录", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const payee = await newCustomer(`收款${suffix()}`);
    await paidBefore(payer, payee);
    const owner = await newOwner();
    await setBalance(payer.accountId, 100_000);
    await chat(payer.id, "对方说要把钱转到安全账户", new Date());
    const result = await draft(payer, payee, 1_000, owner);
    expect(result).toMatchObject({
      status: "AWAITING_AUTH", riskLevel: "RED", requiredAuth: "MFA",
      fraudHold: { reasons: [expect.objectContaining({ code: "SCAM_PHRASE" })], hotline: expect.stringContaining("96110") },
    });
    expect(result).not.toHaveProperty("ruleId");
    expect(await balanceOf(payer.accountId)).toBe(100_000);
    expect((await query("SELECT 1 FROM transfers WHERE operation_id=$1 AND fraud_reasons IS NOT NULL", [result.operationId])).rowCount).toBe(1);
    expect((await query("SELECT 1 FROM feed_posts WHERE customer_id=$1 AND dedupe_key=$2 AND kind='anomaly'", [payer.id, `fraud:${result.operationId}`])).rowCount).toBe(1);
  });

  it("24 小时后再办：只能设置一次；暂缓期内不能确认（资金不动）；审计里有暂缓开始的记录", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const payee = await newCustomer(`收款${suffix()}`);
    await paidBefore(payer, payee);
    const owner = await newOwner();
    await setBalance(payer.accountId, 100_000);
    await chat(payer.id, "这是安全账户的要求", new Date());
    const result = await draft(payer, payee, 1_000, owner);
    const { holdUntil } = await holdFraudTransfer(payer.id, result.operationId, { impostor: "yes", secrecy: "no" });
    const delta = new Date(holdUntil).getTime() - Date.now();
    expect(delta).toBeGreaterThan(23 * 3_600_000);
    expect(delta).toBeLessThanOrEqual(24 * 3_600_000);
    await expect(holdFraudTransfer(payer.id, result.operationId)).rejects.toThrow("TRANSFER_NOT_HELD");
    await expect(commitTransfer(payer.id, result.operationId, { totpCode: null, taskId: null })).rejects.toBeInstanceOf(FraudHoldError);
    expect(await balanceOf(payer.accountId)).toBe(100_000);
    expect((await query("SELECT 1 FROM audit_events WHERE customer_id=$1 AND event_type='FRAUD_GUARD_COOLING_STARTED'", [payer.id])).rowCount).toBe(1);
  });

  it("暂缓期过后仍需要强验证：不带动态码不会转出", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const payee = await newCustomer(`收款${suffix()}`);
    await paidBefore(payer, payee);
    const owner = await newOwner();
    await setBalance(payer.accountId, 100_000);
    await chat(payer.id, "对方说有保证金要交", new Date());
    const result = await draft(payer, payee, 1_000, owner);
    await holdFraudTransfer(payer.id, result.operationId);
    await query("UPDATE transfers SET hold_until=now() - interval '1 minute' WHERE operation_id=$1", [result.operationId]);
    const attempt = await commitTransfer(payer.id, result.operationId, { totpCode: null, taskId: null });
    expect(attempt).toHaveProperty("authError");
    expect(await balanceOf(payer.accountId)).toBe(100_000);
  });

  it("超过一小时的话不算数：老朋友、没有话术的正常转账不受影响，照常需要确认", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const payee = await newCustomer(`收款${suffix()}`);
    await paidBefore(payer, payee);
    const owner = await newOwner();
    await setBalance(payer.accountId, 100_000);
    await chat(payer.id, "安全账户是什么", new Date(Date.now() - 2 * 3_600_000));
    const result = await draft(payer, payee, 1_000, owner);
    expect(result).toMatchObject({ requiredAuth: "CONFIRM" });
    expect(result.fraudHold).toBeNull();
  });

  it("别人的转账不能被我暂缓", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const payee = await newCustomer(`收款${suffix()}`);
    const outsider = await newCustomer(`别人${suffix()}`);
    await paidBefore(payer, payee);
    const owner = await newOwner();
    await setBalance(payer.accountId, 100_000);
    await chat(payer.id, "洗钱的说法", new Date());
    const result = await draft(payer, payee, 1_000, owner);
    await expect(holdFraudTransfer(outsider.id, result.operationId)).rejects.toThrow("TRANSFER_NOT_HELD");
  });

  it.skipIf(nightNow)("只是草稿、没有真正转出的转账不算“连续转账”：两份草稿分别去了两位新收款人，第二份不暂缓", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const first = await newCustomer(`收款${suffix()}`);
    const second = await newCustomer(`收款${suffix()}`);
    const owner = await newOwner();
    await setBalance(payer.accountId, 100_000);
    await draft(payer, first, 1_000, owner);
    const result = await draft(payer, second, 1_000, owner);
    expect(result.fraudHold).toBeNull();
  });
});
