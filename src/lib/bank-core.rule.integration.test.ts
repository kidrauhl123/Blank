import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { registerCustomer } from "./auth";
import { commitTransfer, prepareTransfer } from "./bank-core";
import { query } from "./db";
import { WALLET_CAPS } from "./wallet-core";
import { createRuleDraft, moveWallet, pauseRule } from "./wallet-store";

const HOUR = 3_600_000;
const PASSWORD = "Test-only-123456";

// 测试库可能被同时跑的其他测试占用，手机号用单独的前缀，避免撞号。
const RUN = String(randomInt(0, 1000)).padStart(3, "0");
let phoneSeq = 0;
const testPhone = () => `1991${RUN}${String(++phoneSeq).padStart(4, "0")}`;
const suffix = () => randomUUID().slice(0, 6);

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
async function balanceOf(accountId: string | null) {
  if (!accountId) return 0;
  return Number((await query<{ balance: string }>("SELECT available_balance_minor AS balance FROM accounts WHERE id=$1", [accountId])).rows[0].balance);
}
async function walletOf(owner: string, customerId: string) {
  const row = (await query<{ account_id: string }>("SELECT account_id FROM wallet_accounts WHERE owner_id=$1 AND customer_id=$2", [owner, customerId])).rows[0];
  if (!row) throw new Error("钱包还没有建立");
  return row.account_id;
}

// 往来 = 账本里双方的储蓄账户出现在同一笔账务中，老联系人要求至少两次。
async function relate(a: Party, b: Party, times: number) {
  for (let i = 0; i < times; i++) {
    const tx = (await query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type,description,posted_at) VALUES($1,'TRANSFER','测试往来',now()) RETURNING id",
      [`BCRULE-${randomUUID()}`])).rows[0];
    await query("INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction) VALUES($1,$2,-1000,'DEBIT'),($1,$3,1000,'CREDIT')", [tx.id, a.accountId, b.accountId]);
  }
}

// 冷静期要等 24 小时：测试里直接把已验证的规矩置为 COOLING，生效时间设在两小时前。
async function activate(ruleId: string) {
  const effectiveAt = new Date(Date.now() - 2 * HOUR);
  await query("UPDATE wallet_rules SET status='COOLING',authorized_by='TOTP',authorized_at=$2,effective_at=$3 WHERE id=$1",
    [ruleId, new Date(effectiveAt.getTime() - WALLET_CAPS.cooldownMs), effectiveAt]);
}

// 付款人主账户有钱、与收款人有两次往来、钱包里有 ¥500，并且有一条已过冷静期、收款人在名单里的规矩。
async function coveredPayer(options: { walletMinor?: number; perTxnYuan?: number; monthlyYuan?: number } = {}) {
  const payer = await newCustomer(`付款人${suffix()}`);
  const recipient = await newCustomer(`收款${suffix()}`);
  await relate(payer, recipient, 2);
  await setBalance(payer.accountId, 1_000_000);
  const owner = await newOwner();
  const funding = await moveWallet(payer.id, owner, "in", options.walletMinor ?? 50_000);
  if (!funding.ok) throw new Error(funding.error);
  const draft = await createRuleDraft(payer.id, owner, { template: "pay_trusted_small", recipients: [recipient.name], perTxnYuan: options.perTxnYuan ?? 300, monthlyYuan: options.monthlyYuan ?? 1000 });
  if (!("ruleId" in draft)) throw new Error(draft.error);
  await activate(draft.ruleId);
  return { payer, recipient, owner, ruleId: draft.ruleId };
}
// 草稿：ownerId 为空时完全不走规矩，就是普通转账。
const draftTransfer = (payer: Party, recipient: Party, amountMinor: number, owner?: string) =>
  prepareTransfer(payer.id, { fromAccountId: payer.accountId, recipient: recipient.phone, amountMinor }, { ownerId: owner ?? null });
const commit = (payer: Party, operationId: string) => commitTransfer(payer.id, operationId, { totpCode: null, taskId: null });

async function statusOf(ruleId: string) {
  return (await query<{ status: string; paused_reason: string | null }>("SELECT status,paused_reason FROM wallet_rules WHERE id=$1", [ruleId])).rows[0];
}

async function cleanup() {
  const customers = created.customers;
  if (customers.length > 0) {
    // 只删本文件造的账务：分录都落在本文件的客户账户上。
    const ourAccounts = "SELECT id FROM accounts WHERE customer_id=ANY($1::uuid[])";
    const ledgerIds = (await query<{ id: string }>(`SELECT DISTINCT ledger_transaction_id AS id FROM ledger_entries WHERE account_id IN (${ourAccounts})`, [customers])).rows.map(row => row.id);
    await query("DELETE FROM ledger_entries WHERE ledger_transaction_id=ANY($1::uuid[])", [ledgerIds]);
    await query("DELETE FROM ledger_transactions WHERE id=ANY($1::uuid[])", [ledgerIds]);
    await query(`DELETE FROM bank_transactions WHERE account_id IN (${ourAccounts})`, [customers]);
    await query("DELETE FROM policy_decisions WHERE operation_id IN (SELECT operation_id FROM transfers WHERE customer_id=ANY($1::uuid[]))", [customers]);
    await query("DELETE FROM authorization_challenges WHERE customer_id=ANY($1::uuid[])", [customers]);
    // transfers 要先于 wallet_rules 删（transfers.rule_id 引用规矩），也要先于 beneficiaries。
    await query("DELETE FROM transfers WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM wallet_rules WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM wallet_accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM beneficiaries WHERE customer_id=ANY($1::uuid[]) OR recipient_customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
  }
  if (created.owners.length > 0) await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [created.owners]);
}

// 规矩的夜间规则按北京时间 23:00–7:00 拒绝自动执行；本文件的转账用真实时间，所以夜里跑会失败，这种时候整组跳过并说明原因。
const beijingHour = new Date(Date.now() + 8 * HOUR).getUTCHours();
const nightNow = beijingHour >= WALLET_CAPS.nightFromHour || beijingHour < WALLET_CAPS.nightToHour;

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1" || nightNow)("规矩转账的数据库路径（bank-core）", () => {
  afterAll(cleanup);

  it("规矩内转账：草稿只做标记不动钱；过账后只动钱包和收款人，规矩与审计都带上", async () => {
    const s = await coveredPayer();
    const mainBefore = await balanceOf(s.payer.accountId);
    const wallet = await walletOf(s.owner, s.payer.id);
    const draft = await draftTransfer(s.payer, s.recipient, 5_000, s.owner);
    expect(draft).toMatchObject({ status: "AWAITING_AUTH", riskLevel: "GREEN", requiredAuth: "NONE", ruleId: s.ruleId });
    expect(await balanceOf(wallet)).toBe(50_000);
    expect(await commit(s.payer, draft.operationId)).toMatchObject({ status: "SUCCEEDED" });
    expect(await balanceOf(wallet)).toBe(45_000);
    expect(await balanceOf(s.payer.accountId)).toBe(mainBefore);
    expect((await query<{ rule_id: string; status: string }>("SELECT rule_id,status FROM transfers WHERE operation_id=$1", [draft.operationId])).rows[0])
      .toEqual({ rule_id: s.ruleId, status: "SUCCEEDED" });
    // 出账记在钱包子账户上（它就是这笔转账的源账户），不在主账户上。
    expect((await query<{ ruleId: string }>("SELECT metadata->>'ruleId' AS \"ruleId\" FROM bank_transactions WHERE account_id=$1 AND category='转账' AND metadata->>'operationId'=$2", [wallet, draft.operationId])).rows[0])
      .toEqual({ ruleId: s.ruleId });
    expect((await query("SELECT 1 FROM policy_decisions WHERE operation_id=$1 AND matched_rules ? 'RULE_COVERED'", [draft.operationId])).rowCount).toBe(1);
  });

  it("主账户余额为 0 也能走规矩：付款的是钱包，不是主账户", async () => {
    const s = await coveredPayer();
    await setBalance(s.payer.accountId, 0);
    const draft = await draftTransfer(s.payer, s.recipient, 5_000, s.owner);
    expect(draft).toMatchObject({ ruleId: s.ruleId, requiredAuth: "NONE" });
    expect(await commit(s.payer, draft.operationId)).toMatchObject({ status: "SUCCEEDED" });
    expect(await balanceOf(await walletOf(s.owner, s.payer.id))).toBe(45_000);
  });

  it("规矩已暂停：不覆盖，走普通流程（需要用户确认，不是免确认）", async () => {
    const s = await coveredPayer();
    await pauseRule(s.payer.id, s.owner, s.ruleId);
    expect((await statusOf(s.ruleId)).status).toBe("PAUSED");
    const draft = await draftTransfer(s.payer, s.recipient, 5_000, s.owner);
    expect(draft).not.toHaveProperty("ruleId");
    expect(draft.requiredAuth).not.toBe("NONE");
    expect(await balanceOf(await walletOf(s.owner, s.payer.id))).toBe(50_000);
  });

  it("连续 3 笔规矩转账后第 4 笔被突发拒绝并暂停规矩；随后普通流程因余额不足报错，暂停仍然保留", async () => {
    const s = await coveredPayer({ walletMinor: 100_000 });
    for (let i = 0; i < WALLET_CAPS.burstLimit; i++) {
      const draft = await draftTransfer(s.payer, s.recipient, 10_000, s.owner);
      expect(draft).toMatchObject({ ruleId: s.ruleId });
      expect(await commit(s.payer, draft.operationId)).toMatchObject({ status: "SUCCEEDED" });
    }
    await setBalance(s.payer.accountId, 0);
    await expect(draftTransfer(s.payer, s.recipient, 10_000, s.owner)).rejects.toThrow("INSUFFICIENT_FUNDS");
    expect(await statusOf(s.ruleId)).toMatchObject({ status: "PAUSED", paused_reason: "转账的金额或频率异常" });
  });

  it("草稿之后、过账之前规矩被暂停：过账取消，钱不动，留下审计", async () => {
    const s = await coveredPayer();
    const wallet = await walletOf(s.owner, s.payer.id);
    const draft = await draftTransfer(s.payer, s.recipient, 5_000, s.owner);
    await pauseRule(s.payer.id, s.owner, s.ruleId);
    const done = await commit(s.payer, draft.operationId);
    expect(done).toMatchObject({ status: "CANCELLED", reasons: [expect.any(String)] });
    expect((await query<{ status: string }>("SELECT status FROM transfers WHERE operation_id=$1", [draft.operationId])).rows[0].status).toBe("CANCELLED");
    expect(await balanceOf(wallet)).toBe(50_000);
    expect((await query("SELECT 1 FROM audit_events WHERE customer_id=$1 AND event_type='TRANSFER_CANCELLED_BY_RULE' AND evidence->>'ruleId'=$2", [s.payer.id, s.ruleId])).rowCount).toBe(1);
  });

  it("草稿时当天还没超口径，过账前同一天另有一笔转账把合计推过口径：规矩内的这笔取消，不升级成强验证", async () => {
    const s = await coveredPayer({ walletMinor: 100_000 });
    const draft = await draftTransfer(s.payer, s.recipient, 20_000, s.owner);
    expect(draft).toMatchObject({ ruleId: s.ruleId });
    // 不经过规矩的普通转账 ¥990：草稿时它还不存在，所以规矩草稿是覆盖的。
    const other = await draftTransfer(s.payer, s.recipient, 99_000);
    expect(other).not.toHaveProperty("ruleId");
    expect(await commit(s.payer, other.operationId)).toMatchObject({ status: "SUCCEEDED" });
    const done = await commit(s.payer, draft.operationId);
    expect(done).toEqual({ operationId: draft.operationId, status: "CANCELLED", reasons: ["今天的转账已较多，这笔照常由你确认"] });
    expect((await query<{ status: string }>("SELECT status FROM transfers WHERE operation_id=$1", [draft.operationId])).rows[0].status).toBe("CANCELLED");
    expect(await balanceOf(await walletOf(s.owner, s.payer.id))).toBe(100_000);
  });

  it("同一访客的草稿与过账并发执行：不会死锁，每笔都是成功或取消", async () => {
    const s = await coveredPayer({ walletMinor: 200_000, perTxnYuan: 300, monthlyYuan: 1000 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, async () => {
      const draft = await draftTransfer(s.payer, s.recipient, 5_000, s.owner);
      return commit(s.payer, draft.operationId);
    }));
    for (const result of results) {
      if (result.status === "rejected") expect(String(result.reason)).not.toMatch(/deadlock/i);
    }
    const statuses = results.map(result => (result.status === "fulfilled" ? result.value.status : "ERROR"));
    expect(statuses.filter(status => status === "ERROR")).toHaveLength(0);
    expect(statuses.every(status => status === "SUCCEEDED" || status === "CANCELLED")).toBe(true);
  });
});
