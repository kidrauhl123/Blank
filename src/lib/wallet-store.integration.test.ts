import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTotpSetup, confirmTotpSetup, registerCustomer } from "./auth";
import { db, query, withTransaction } from "./db";
import type { PasskeyProof } from "./passkey";
import { DAILY_TRANSFER_RED_THRESHOLD_MINOR } from "./policy";
import { WALLET_CAPS } from "./wallet-core";
import { authorizeRule, createRuleDraft, dismissRule, findCoveringRule, moveWallet, pauseRule, revokeRule, walletOverview } from "./wallet-store";

// 真实数据库的集成测试（造数据、清理的写法参考 feed-recipe-store.integration.test.ts）。
// 只造本文件自己的客户、账户和账务，结束时按外键顺序清理；不向 demo_profiles 写入任何行。

const MIN = 60_000;
const HOUR = 60 * MIN;
// 北京时间 2026-10-31 10:00：白天，不触发深夜规则。所有“现在”都显式传入，结果不随真实时钟变化。
const DAY = new Date("2026-10-31T02:00:00Z");
const PASSWORD = "Test-only-123456";

// 库里没有导出的动态码生成函数，这里与 totp-setup 等集成测试的算法一致（SHA-1、6 位、30 秒步长）。
function totpCode(secret: string, step: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(value => parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
const currentStep = () => Math.floor(Date.now() / 30_000);
// 前后两步都不命中的错码，保证一定被拒绝。
function wrongCode(secret: string) {
  const valid = new Set([-2, -1, 0, 1, 2].map(offset => totpCode(secret, currentStep() + offset)));
  return ["000000", "000001", "000002"].find(code => !valid.has(code)) ?? "999999";
}

// 手机号以 1990 开头，清理后可用 phone LIKE '1990%' 查残留；收款人姓名不超过 12 个字，所以后缀只取 6 位。
const RUN = String(randomInt(0, 1000)).padStart(3, "0");
let phoneSeq = 0;
const testPhone = () => `1990${RUN}${String(++phoneSeq).padStart(4, "0")}`;
const suffix = () => randomUUID().slice(0, 6);

const created = { customers: [] as string[], owners: [] as string[] };
type Party = { id: string; name: string; accountId: string };

async function newCustomer(displayName: string): Promise<Party> {
  const identity = await registerCustomer({ displayName, phone: testPhone(), password: PASSWORD });
  const id = identity.customer.id;
  created.customers.push(id);
  const account = (await query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=$1 AND account_type='CHECKING'", [id])).rows[0];
  return { id, name: displayName, accountId: account.id };
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
// 钱包按（访客, 客户）各一个：同一访客的另一位客户有自己的钱包。
async function walletAccountOf(owner: string, customerId: string) {
  return (await query<{ account_id: string }>("SELECT account_id FROM wallet_accounts WHERE owner_id=$1 AND customer_id=$2", [owner, customerId])).rows[0]?.account_id ?? null;
}
async function walletOf(owner: string, customerId: string) {
  const id = await walletAccountOf(owner, customerId);
  if (!id) throw new Error("钱包还没有建立");
  return id;
}

// 往来 = 账本里双方的储蓄账户出现在同一笔账务中（借贷各一条，账本平衡）。
async function relate(a: Party, b: Party, times: number, postedAt = new Date()) {
  for (let i = 0; i < times; i++) {
    const tx = (await query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type,description,posted_at) VALUES($1,'TRANSFER','测试往来',$2) RETURNING id",
      [`WTEST-${randomUUID()}`, postedAt])).rows[0];
    await query("INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction) VALUES($1,$2,-1000,'DEBIT'),($1,$3,1000,'CREDIT')", [tx.id, a.accountId, b.accountId]);
  }
}
// 付款人（与收款人有两次往来，是老联系人）和一位访客。
async function parties() {
  const payer = await newCustomer(`付款人${suffix()}`);
  const recipient = await newCustomer(`收款${suffix()}`);
  await relate(payer, recipient, 2);
  return { payer, recipient, owner: await newOwner() };
}
async function enrollTotp(customerId: string) {
  const { secret } = await beginTotpSetup(customerId);
  await confirmTotpSetup(customerId, totpCode(secret, currentStep()));
  return secret;
}

const draftInput = (recipients: string[]) => ({ template: "pay_trusted_small", recipients, perTxnYuan: 300, monthlyYuan: 1000 });
async function proposeRule(payer: Party, owner: string, recipients: string[], perTxnYuan = 300, monthlyYuan = 1000) {
  const result = await createRuleDraft(payer.id, owner, { template: "pay_trusted_small", recipients, perTxnYuan, monthlyYuan });
  if (!("ruleId" in result)) throw new Error(`提议失败：${result.error}`);
  return result.ruleId;
}
// 冷静期要等 24 小时，动态码每 30 秒才能用一次：测试里把已验证的规矩直接置为 COOLING，生效时间由用例指定。
async function activate(ruleId: string, effectiveAt: Date) {
  await query("UPDATE wallet_rules SET status='COOLING',authorized_by='TOTP',authorized_at=$2,effective_at=$3 WHERE id=$1",
    [ruleId, new Date(effectiveAt.getTime() - WALLET_CAPS.cooldownMs), effectiveAt]);
}
async function statusOf(ruleId: string) {
  return (await query<{ status: string; paused_reason: string | null; revoked_at: Date | null }>("SELECT status,paused_reason,revoked_at FROM wallet_rules WHERE id=$1", [ruleId])).rows[0];
}
async function countRules(owner: string) {
  return (await query<{ count: number }>("SELECT count(*)::int AS count FROM wallet_rules WHERE owner_id=$1", [owner])).rows[0].count;
}
// 历史转账：直接写入一笔已成功（或失败）的转账，用来造出“本月已转出”和“平时的金额”，不经过转账流程。
async function paidUnder(payer: Party, recipient: Party, ruleId: string | null, amountMinor: number, executedAt: Date, status = "SUCCEEDED") {
  const beneficiary = (await query<{ id: string }>(`INSERT INTO beneficiaries(customer_id,name,bank_name,masked_account,settlement_account_id,recipient_customer_id)
    VALUES($1,$2,'Blank','•• 0000',$3,$4) ON CONFLICT (customer_id,settlement_account_id) DO UPDATE SET name=excluded.name RETURNING id`,
    [payer.id, recipient.name, recipient.accountId, recipient.id])).rows[0];
  await query(`INSERT INTO transfers(operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,risk_level,required_auth,status,authorization_fingerprint,executed_at,rule_id)
    VALUES($1,$2,$3,$4,$5,$6,'GREEN','NONE',$7,'test-fixture',$8,$9)`,
  [`WTEST-${randomUUID()}`, randomUUID(), payer.id, payer.accountId, beneficiary.id, amountMinor, status, executedAt, ruleId]);
}
const covering = (payer: Party, owner: string, recipient: Party, amountMinor: number, now = DAY, dailyTotalMinor = 0) =>
  withTransaction(client => findCoveringRule(client, payer.id, owner, recipient.id, amountMinor, dailyTotalMinor, now));

// 冷静期已过、收款人在名单里的一条规矩，钱包里有 ¥500（可以用各个用例改动的参数覆盖默认值）。
async function coveredScenario(options: { walletMinor?: number; perTxnYuan?: number; monthlyYuan?: number; effectiveAt?: Date } = {}) {
  const { payer, recipient, owner } = await parties();
  const stranger = await newCustomer(`收款${suffix()}`);
  await relate(payer, stranger, 2);
  await setBalance(payer.accountId, 1_000_000);
  const funding = await moveWallet(payer.id, owner, "in", options.walletMinor ?? 50_000);
  if (!funding.ok) throw new Error(funding.error);
  const ruleId = await proposeRule(payer, owner, [recipient.name], options.perTxnYuan, options.monthlyYuan);
  await activate(ruleId, options.effectiveAt ?? new Date(DAY.getTime() - 24 * HOUR));
  return { payer, recipient, stranger, owner, ruleId };
}

// 账务按账务编号分组，每一笔都必须借贷平衡（两条分录、金额相加为 0）。
async function ledgerTouching(accountId: string) {
  const rows = (await query<{ ledger_transaction_id: string; account_id: string; amount_minor: string; direction: string }>(
    `SELECT ledger_transaction_id,account_id,amount_minor::text AS amount_minor,direction FROM ledger_entries
     WHERE ledger_transaction_id IN (SELECT ledger_transaction_id FROM ledger_entries WHERE account_id=$1)`, [accountId])).rows;
  const byTransaction = new Map<string, Array<{ accountId: string; amount: number; direction: string }>>();
  for (const row of rows) {
    const entries = byTransaction.get(row.ledger_transaction_id) ?? [];
    entries.push({ accountId: row.account_id, amount: Number(row.amount_minor), direction: row.direction });
    byTransaction.set(row.ledger_transaction_id, entries);
  }
  return [...byTransaction.values()];
}
const sumOf = (entries: Array<{ amount: number }>) => entries.reduce((total, entry) => total + entry.amount, 0);

async function cleanup() {
  const customers = created.customers;
  if (customers.length > 0) {
    // 只删本文件造的账务：所有分录都落在本文件的客户账户上。
    const ourAccounts = "SELECT id FROM accounts WHERE customer_id=ANY($1::uuid[])";
    const ledgerIds = (await query<{ id: string }>(`SELECT DISTINCT ledger_transaction_id AS id FROM ledger_entries WHERE account_id IN (${ourAccounts})`, [customers])).rows.map(row => row.id);
    await query("DELETE FROM ledger_entries WHERE ledger_transaction_id=ANY($1::uuid[])", [ledgerIds]);
    await query("DELETE FROM ledger_transactions WHERE id=ANY($1::uuid[])", [ledgerIds]);
    await query(`DELETE FROM bank_transactions WHERE account_id IN (${ourAccounts})`, [customers]);
    await query("DELETE FROM transfers WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM wallet_rules WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM wallet_accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM beneficiaries WHERE customer_id=ANY($1::uuid[]) OR recipient_customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    // 凭据、会话、动态码都是 ON DELETE CASCADE。
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
  }
  if (created.owners.length > 0) await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [created.owners]);
}

// 需要本地测试库：BANKPILOT_DB_TESTS=1，且 DATABASE_URL 指向隔离的 bankpilot_test（见 common.md）。
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("钱包存储层（真实数据库）", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    if (!process.env.PASSWORD_PEPPER) throw new Error("Use a test-only PASSWORD_PEPPER");
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  describe("createRuleDraft 提议规矩", () => {
    it.each([
      ["单笔超过 500 元", { perTxnYuan: 501 }, "perTxnYuan"],
      ["每月超过 2000 元", { monthlyYuan: 2001 }, "monthlyYuan"],
      ["单笔高于每月", { perTxnYuan: 400, monthlyYuan: 300 }, "单笔上限不能高于每月上限"],
      ["收款人超过 5 个", { recipients: ["甲", "乙", "丙", "丁", "戊", "己"] }, "recipients"],
      ["收款人重复", { recipients: ["甲", "甲"] }, "收款人重复了"],
      ["金额不是整数元", { perTxnYuan: 1.5 }, "perTxnYuan"],
    ])("%s：返回错误，且不插入规则", async (_label, overrides, message) => {
      const owner = await newOwner();
      const result = await createRuleDraft(randomUUID(), owner, { ...draftInput(["甲"]), ...overrides });
      expect(result).toEqual({ error: expect.stringContaining(message) });
      expect(await countRules(owner)).toBe(0);
    });

    it("收款人不是老联系人（往来不足 2 次，或只有 180 天前的往来）时拒绝", async () => {
      const payer = await newCustomer(`付款人${suffix()}`);
      const owner = await newOwner();
      const never = await newCustomer(`收款${suffix()}`);
      const once = await newCustomer(`收款${suffix()}`);
      await relate(payer, once, 1);
      const stale = await newCustomer(`收款${suffix()}`);
      await relate(payer, stale, 2, new Date(Date.now() - 200 * 24 * HOUR));
      for (const recipient of [never, once, stale]) {
        expect(await createRuleDraft(payer.id, owner, draftInput([recipient.name]))).toEqual({
          error: expect.stringContaining(`「${recipient.name}」和你的往来不到 ${WALLET_CAPS.minRelations} 次`),
        });
      }
      expect(await countRules(owner)).toBe(0);
    });

    it("收款人找不到，或同名有多位用户时拒绝", async () => {
      const payer = await newCustomer(`付款人${suffix()}`);
      const owner = await newOwner();
      const name = `同名${suffix()}`;
      await newCustomer(name);
      await newCustomer(name);
      expect(await createRuleDraft(payer.id, owner, draftInput([`无此人${suffix()}`]))).toEqual({ error: expect.stringContaining("找不到名叫") });
      expect(await createRuleDraft(payer.id, owner, draftInput([name]))).toEqual({ error: expect.stringContaining("不止一位用户") });
      expect(await countRules(owner)).toBe(0);
    });

    it("老联系人：返回 ruleId 和 marker，状态为 DRAFT，名单里保存的是收款人 ID", async () => {
      const { payer, recipient, owner } = await parties();
      const result = await createRuleDraft(payer.id, owner, draftInput([recipient.name]));
      if (!("ruleId" in result)) throw new Error(result.error);
      expect(result.marker).toBe(`[[rule:${result.ruleId}]]`);
      const row = (await query<{ status: string; params: unknown }>("SELECT status,params FROM wallet_rules WHERE id=$1", [result.ruleId])).rows[0];
      expect(row.status).toBe("DRAFT");
      expect(row.params).toEqual({ recipients: [recipient.name], recipientIds: [recipient.id], perTxnMinor: 30_000, monthlyMinor: 100_000 });
    });

    it("再次提议会作废还没确认的旧草稿", async () => {
      const { payer, recipient, owner } = await parties();
      const first = await proposeRule(payer, owner, [recipient.name]);
      const second = await proposeRule(payer, owner, [recipient.name]);
      expect((await statusOf(first)).status).toBe("DISMISSED");
      expect((await statusOf(second)).status).toBe("DRAFT");
    });

    it("已有 3 条未完成的规矩（冷静期或暂停中）时，不再提议", async () => {
      const { payer, recipient, owner } = await parties();
      const first = await proposeRule(payer, owner, [recipient.name]);
      await activate(first, new Date(DAY.getTime() - 24 * HOUR));
      const second = await proposeRule(payer, owner, [recipient.name]);
      await activate(second, new Date(DAY.getTime() - 24 * HOUR));
      expect(await pauseRule(payer.id, owner, second)).toBe(true);
      const third = await proposeRule(payer, owner, [recipient.name]);
      await activate(third, new Date(DAY.getTime() - 24 * HOUR));
      expect(await createRuleDraft(payer.id, owner, draftInput([recipient.name]))).toEqual({ error: expect.stringContaining("最多同时保留 3 条规矩") });
      expect(await countRules(owner)).toBe(3);
    });
  });

  describe("authorizeRule 本人强验证（TOTP）", () => {
    it("没开启 TOTP 时返回 MFA_NOT_CONFIGURED，草稿保持不变", async () => {
      const { payer, recipient, owner } = await parties();
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: "000000" })).toEqual({ ok: false, error: "MFA_NOT_CONFIGURED" });
      expect((await statusOf(ruleId)).status).toBe("DRAFT");
    });

    it("动态码正确：进入 24 小时冷静期，并写入授权方式、钱包和审计", async () => {
      const { payer, recipient, owner } = await parties();
      const secret = await enrollTotp(payer.id);
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      const now = new Date();
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: totpCode(secret, currentStep() + 1) }, now)).toEqual({ ok: true });
      const row = (await query<{ status: string; authorized_by: string; authorized_at: Date; effective_at: Date }>(
        "SELECT status,authorized_by,authorized_at,effective_at FROM wallet_rules WHERE id=$1", [ruleId])).rows[0];
      expect(row.status).toBe("COOLING");
      expect(row.authorized_by).toBe("TOTP");
      expect(row.authorized_at.getTime()).toBe(now.getTime());
      expect(row.effective_at.getTime()).toBe(now.getTime() + WALLET_CAPS.cooldownMs);
      expect(await walletAccountOf(owner, payer.id)).not.toBeNull();
      expect((await query("SELECT 1 FROM audit_events WHERE customer_id=$1 AND event_type='WALLET_RULE_AUTHORIZED' AND evidence->>'ruleId'=$2", [payer.id, ruleId])).rowCount).toBe(1);
    });

    it("同一个动态码不能用第二次：MFA_REPLAYED", async () => {
      const { payer, recipient, owner } = await parties();
      const secret = await enrollTotp(payer.id);
      const first = await proposeRule(payer, owner, [recipient.name]);
      const code = totpCode(secret, currentStep() + 1);
      expect(await authorizeRule(payer.id, owner, first, { method: "TOTP", code })).toEqual({ ok: true });
      const second = await proposeRule(payer, owner, [recipient.name]);
      expect(await authorizeRule(payer.id, owner, second, { method: "TOTP", code })).toEqual({ ok: false, error: "MFA_REPLAYED" });
      expect((await statusOf(second)).status).toBe("DRAFT");
    });

    it("草稿超过 30 分钟不能再确认（RULE_NOT_PENDING）；恰好 30 分钟仍在窗口内，会继续校验动态码", async () => {
      const { payer, recipient, owner } = await parties();
      const secret = await enrollTotp(payer.id);
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      const draftedAt = (await query<{ created_at: Date }>("SELECT created_at FROM wallet_rules WHERE id=$1", [ruleId])).rows[0].created_at;
      const code = wrongCode(secret);
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code }, new Date(draftedAt.getTime() + 30 * MIN))).toEqual({ ok: false, error: "MFA_INVALID" });
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code }, new Date(draftedAt.getTime() + 31 * MIN))).toEqual({ ok: false, error: "RULE_NOT_PENDING" });
      expect((await statusOf(ruleId)).status).toBe("DRAFT");
    });

    it("动态码错误返回 MFA_INVALID，草稿保持 DRAFT", async () => {
      const { payer, recipient, owner } = await parties();
      const secret = await enrollTotp(payer.id);
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: wrongCode(secret) })).toEqual({ ok: false, error: "MFA_INVALID" });
      expect((await statusOf(ruleId)).status).toBe("DRAFT");
    });

    it("连续 3 次错码后锁定：第 3 次返回 AUTH_FUSE_ACTIVE，锁定期内正确的码也不行", async () => {
      const { payer, recipient, owner } = await parties();
      const secret = await enrollTotp(payer.id);
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      const wrong = wrongCode(secret);
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: wrong })).toEqual({ ok: false, error: "MFA_INVALID" });
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: wrong })).toEqual({ ok: false, error: "MFA_INVALID" });
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: wrong })).toEqual({ ok: false, error: "AUTH_FUSE_ACTIVE" });
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: totpCode(secret, currentStep() + 1) })).toEqual({ ok: false, error: "AUTH_FUSE_ACTIVE" });
      expect((await statusOf(ruleId)).status).toBe("DRAFT");
    });

    it("规矩已经不是草稿（已确认过）：返回 RULE_NOT_PENDING，状态不变", async () => {
      const { payer, recipient, owner } = await parties();
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      await activate(ruleId, new Date(DAY.getTime() + 24 * HOUR));
      const before = await statusOf(ruleId);
      expect(await authorizeRule(payer.id, owner, ruleId, { method: "TOTP", code: "000000" })).toEqual({ ok: false, error: "RULE_NOT_PENDING" });
      expect(await statusOf(ruleId)).toEqual(before);
    });

    it("别的访客（即使是同一位客户）或别的客户都不能确认这条规矩：RULE_NOT_FOUND", async () => {
      const { payer, recipient, owner } = await parties();
      const otherOwner = await newOwner();
      const otherCustomer = await newCustomer(`付款人${suffix()}`);
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      expect(await authorizeRule(payer.id, otherOwner, ruleId, { method: "TOTP", code: "000000" })).toEqual({ ok: false, error: "RULE_NOT_FOUND" });
      expect(await authorizeRule(otherCustomer.id, owner, ruleId, { method: "TOTP", code: "000000" })).toEqual({ ok: false, error: "RULE_NOT_FOUND" });
      expect(await authorizeRule(payer.id, owner, randomUUID(), { method: "TOTP", code: "000000" })).toEqual({ ok: false, error: "RULE_NOT_FOUND" });
      expect((await statusOf(ruleId)).status).toBe("DRAFT");
    });

    it("通行证不是为这条规矩签的：PASSKEY_INVALID，规矩不变", async () => {
      const { payer, recipient, owner } = await parties();
      const ruleId = await proposeRule(payer, owner, [recipient.name]);
      // 通行证只能由验证函数生成，这里伪造一个 ruleId 对不上的对象，只测这道对不上的闸。
      const forged = { method: "PASSKEY", ruleId: randomUUID() } as unknown as PasskeyProof;
      expect(await authorizeRule(payer.id, owner, ruleId, forged)).toEqual({ ok: false, error: "PASSKEY_INVALID" });
      expect((await statusOf(ruleId)).status).toBe("DRAFT");
    });

    it("确认时已有 3 条未完成的规矩：动态码即使正确也不进入冷静期", async () => {
      const { payer, recipient, owner } = await parties();
      const secret = await enrollTotp(payer.id);
      const first = await proposeRule(payer, owner, [recipient.name]);
      await activate(first, new Date(DAY.getTime() - 24 * HOUR));
      const second = await proposeRule(payer, owner, [recipient.name]);
      await activate(second, new Date(DAY.getTime() - 24 * HOUR));
      const draft = await proposeRule(payer, owner, [recipient.name]);
      // 草稿在这里之后就没法再提议了（满额会拒绝），所以第三条直接按同样的参数补成冷静期规矩。
      await query(`INSERT INTO wallet_rules(customer_id,owner_id,template,params,status,authorized_by,authorized_at,effective_at)
        SELECT customer_id,owner_id,template,params,'COOLING','TOTP',now(),now()+interval '1 day' FROM wallet_rules WHERE id=$1`, [first]);
      expect(await authorizeRule(payer.id, owner, draft, { method: "TOTP", code: totpCode(secret, currentStep() + 1) })).toEqual({ ok: false, error: "RULE_NOT_PENDING" });
      expect((await statusOf(draft)).status).toBe("DRAFT");
    });
  });

  describe("dismissRule / revokeRule / pauseRule 放弃、撤销、暂停", () => {
    it("放弃（dismiss）只对本人的草稿生效，冷静期中的规矩不能放弃", async () => {
      const { payer, recipient, owner } = await parties();
      const other = await newOwner();
      const draft = await proposeRule(payer, owner, [recipient.name]);
      expect(await dismissRule(payer.id, other, draft)).toBe(false);
      expect((await statusOf(draft)).status).toBe("DRAFT");
      expect(await dismissRule(payer.id, owner, draft)).toBe(true);
      expect((await statusOf(draft)).status).toBe("DISMISSED");
      expect(await dismissRule(payer.id, owner, draft)).toBe(false);
      const cooling = await proposeRule(payer, owner, [recipient.name]);
      await activate(cooling, new Date(DAY.getTime() - 24 * HOUR));
      expect(await dismissRule(payer.id, owner, cooling)).toBe(false);
      expect((await statusOf(cooling)).status).toBe("COOLING");
    });

    it("撤销（revoke）：本人的草稿、冷静期、暂停中的规矩都能撤销，别人的不能，撤销后不能再撤", async () => {
      const { payer, recipient, owner } = await parties();
      const other = await newOwner();
      const cooling = await proposeRule(payer, owner, [recipient.name]);
      await activate(cooling, new Date(DAY.getTime() - 24 * HOUR));
      const paused = await proposeRule(payer, owner, [recipient.name]);
      await activate(paused, new Date(DAY.getTime() - 24 * HOUR));
      expect(await pauseRule(payer.id, owner, paused)).toBe(true);
      const draft = await proposeRule(payer, owner, [recipient.name]);
      expect(await revokeRule(payer.id, other, cooling)).toBe(false);
      expect(await revokeRule(payer.id, owner, cooling)).toBe(true);
      expect(await revokeRule(payer.id, owner, paused)).toBe(true);
      expect(await revokeRule(payer.id, owner, draft)).toBe(true);
      for (const ruleId of [cooling, paused, draft]) {
        const row = await statusOf(ruleId);
        expect(row.status).toBe("REVOKED");
        expect(row.revoked_at).not.toBeNull();
      }
      expect(await revokeRule(payer.id, owner, cooling)).toBe(false);
    });

    it("暂停（pause）只作用于本人冷静期中的规矩，并写明是你手动暂停", async () => {
      const { payer, recipient, owner } = await parties();
      const other = await newOwner();
      const rule = await proposeRule(payer, owner, [recipient.name]);
      expect(await pauseRule(payer.id, owner, rule)).toBe(false);
      await activate(rule, new Date(DAY.getTime() - 24 * HOUR));
      expect(await pauseRule(payer.id, other, rule)).toBe(false);
      expect(await pauseRule(payer.id, owner, rule)).toBe(true);
      expect(await statusOf(rule)).toMatchObject({ status: "PAUSED", paused_reason: "你手动暂停" });
      expect(await pauseRule(payer.id, owner, rule)).toBe(false);
      const audit = await query("SELECT 1 FROM audit_events WHERE customer_id=$1 AND event_type='WALLET_RULE_PAUSED_BY_USER' AND evidence->>'ruleId'=$2", [payer.id, rule]);
      expect(audit.rowCount).toBe(1);
    });
  });

  describe("findCoveringRule 转账时判断是否由规矩覆盖", () => {
    it("冷静期未到不覆盖；到点（生效时间等于现在）才覆盖", async () => {
      const s = await coveredScenario({ effectiveAt: new Date(DAY.getTime() + HOUR) });
      expect(await covering(s.payer, s.owner, s.recipient, 3_000)).toEqual({ covered: false, reasons: [], paused: false });
      expect((await statusOf(s.ruleId)).status).toBe("COOLING");
      expect(await covering(s.payer, s.owner, s.recipient, 3_000, new Date(DAY.getTime() + HOUR)))
        .toEqual({ covered: true, ruleId: s.ruleId, walletAccountId: await walletOf(s.owner, s.payer.id), walletBalanceMinor: 50_000 });
    });

    it("冷静期已过、收款人在名单里、额度和余额都够：覆盖，并返回规矩与钱包账户", async () => {
      const s = await coveredScenario();
      expect(await covering(s.payer, s.owner, s.recipient, 3_000))
        .toEqual({ covered: true, ruleId: s.ruleId, walletAccountId: await walletOf(s.owner, s.payer.id), walletBalanceMinor: 50_000 });
    });

    it("收款人不在名单里（即使也是老联系人）不覆盖，且不暂停", async () => {
      const s = await coveredScenario();
      expect(await covering(s.payer, s.owner, s.stranger, 3_000)).toEqual({ covered: false, reasons: [], paused: false });
      expect((await statusOf(s.ruleId)).status).toBe("COOLING");
    });

    it("单笔超过上限不覆盖且不暂停；恰好等于上限则覆盖", async () => {
      const s = await coveredScenario({ perTxnYuan: 300 });
      expect(await covering(s.payer, s.owner, s.recipient, 30_001)).toEqual({ covered: false, reasons: ["超过单笔上限"], paused: false });
      expect((await statusOf(s.ruleId)).status).toBe("COOLING");
      expect(await covering(s.payer, s.owner, s.recipient, 30_000)).toMatchObject({ covered: true, ruleId: s.ruleId });
    });

    it("本规矩本月额度用完不覆盖；恰好用到月额度则覆盖", async () => {
      const s = await coveredScenario({ monthlyYuan: 1000 });
      for (let i = 0; i < 3; i++) await paidUnder(s.payer, s.recipient, s.ruleId, 30_000, new Date(DAY.getTime() - 2 * 24 * HOUR));
      expect(await covering(s.payer, s.owner, s.recipient, 20_000)).toEqual({ covered: false, reasons: ["本规矩本月额度用完了"], paused: false });
      expect(await covering(s.payer, s.owner, s.recipient, 10_000)).toMatchObject({ covered: true, ruleId: s.ruleId });
    });

    it("全部规矩本月合计到 ¥2,000 时不覆盖", async () => {
      const s = await coveredScenario({ monthlyYuan: 2000 });
      const second = await proposeRule(s.payer, s.owner, [s.recipient.name], 300, 2000);
      await activate(second, new Date(DAY.getTime() - 24 * HOUR));
      await paidUnder(s.payer, s.recipient, s.ruleId, 100_000, new Date(DAY.getTime() - 2 * 24 * HOUR));
      await paidUnder(s.payer, s.recipient, second, 100_000, new Date(DAY.getTime() - 2 * 24 * HOUR));
      expect(await covering(s.payer, s.owner, s.recipient, 20_000)).toEqual({ covered: false, reasons: ["全部规矩本月合计已到上限"], paused: false });
    });

    it("钱包余额不够不覆盖，且不暂停", async () => {
      const s = await coveredScenario({ walletMinor: 1_000 });
      expect(await covering(s.payer, s.owner, s.recipient, 3_000)).toEqual({ covered: false, reasons: ["钱包余额不够，这笔照常由你确认"], paused: false });
      expect((await statusOf(s.ruleId)).status).toBe("COOLING");
    });

    it("付款人当天的转账超过每日红线不覆盖；恰好到线则覆盖", async () => {
      const s = await coveredScenario();
      expect(await covering(s.payer, s.owner, s.recipient, 3_000, DAY, DAILY_TRANSFER_RED_THRESHOLD_MINOR - 2_000))
        .toEqual({ covered: false, reasons: ["今天的转账已较多，这笔照常由你确认"], paused: false });
      expect(await covering(s.payer, s.owner, s.recipient, 3_000, DAY, DAILY_TRANSFER_RED_THRESHOLD_MINOR - 3_000)).toMatchObject({ covered: true });
    });

    it.each([["23:00", "2026-10-31T15:00:00Z"], ["06:59", "2026-10-30T22:59:00Z"]])("北京时间 %s 属于深夜：不覆盖，也不暂停规矩", async (_clock, iso) => {
      const s = await coveredScenario();
      expect(await covering(s.payer, s.owner, s.recipient, 3_000, new Date(iso))).toEqual({ covered: false, reasons: ["深夜的转账不自动执行，照常由你确认"], paused: false });
      expect((await statusOf(s.ruleId)).status).toBe("COOLING");
    });

    it.each([["22:59", "2026-10-31T14:59:00Z"], ["07:00", "2026-10-30T23:00:00Z"]])("北京时间 %s 不属于深夜：正常覆盖", async (_clock, iso) => {
      const s = await coveredScenario();
      expect(await covering(s.payer, s.owner, s.recipient, 3_000, new Date(iso))).toMatchObject({ covered: true, ruleId: s.ruleId });
    });

    it("10 分钟内已自动转出 3 笔：不覆盖，并暂停这位访客的全部规矩，写入审计", async () => {
      const s = await coveredScenario();
      const otherRule = await proposeRule(s.payer, s.owner, [s.stranger.name]);
      await activate(otherRule, new Date(DAY.getTime() - 24 * HOUR));
      for (const minutes of [1, 2, 3]) await paidUnder(s.payer, s.recipient, s.ruleId, 10_000, new Date(DAY.getTime() - minutes * MIN));
      expect(await covering(s.payer, s.owner, s.recipient, 10_000)).toEqual({ covered: false, reasons: ["10 分钟内自动转出次数过多，规矩已暂停"], paused: true });
      expect(await statusOf(s.ruleId)).toMatchObject({ status: "PAUSED", paused_reason: "转账的金额或频率异常" });
      expect((await statusOf(otherRule)).status).toBe("PAUSED");
      const audit = await query<{ evidence: { count: number } }>("SELECT evidence FROM audit_events WHERE customer_id=$1 AND event_type='WALLET_RULES_PAUSED'", [s.payer.id]);
      expect(audit.rows.map(row => row.evidence.count)).toEqual([2]);
    });

    it("10 分钟内只有 2 笔不算突发；10 分钟前的那笔不计入", async () => {
      const s = await coveredScenario();
      for (const minutes of [1, 2, 11]) await paidUnder(s.payer, s.recipient, s.ruleId, 10_000, new Date(DAY.getTime() - minutes * MIN));
      expect(await covering(s.payer, s.owner, s.recipient, 10_000)).toMatchObject({ covered: true, ruleId: s.ruleId });
      expect((await statusOf(s.ruleId)).status).toBe("COOLING");
    });

    it("金额达到平时 2 倍就不覆盖并暂停全部规矩；差 1 分仍覆盖", async () => {
      const s = await coveredScenario();
      for (let i = 0; i < 3; i++) await paidUnder(s.payer, s.recipient, s.ruleId, 10_000, new Date(DAY.getTime() - 2 * 24 * HOUR));
      expect(await covering(s.payer, s.owner, s.recipient, 19_999)).toMatchObject({ covered: true, ruleId: s.ruleId });
      expect((await statusOf(s.ruleId)).status).toBe("COOLING");
      expect(await covering(s.payer, s.owner, s.recipient, 20_000)).toEqual({ covered: false, reasons: ["金额明显高于平时，规矩已暂停，请你本人确认"], paused: true });
      expect((await statusOf(s.ruleId)).status).toBe("PAUSED");
    });

    it("手动暂停的规矩不再覆盖，也不算新的异常", async () => {
      const s = await coveredScenario();
      expect(await pauseRule(s.payer.id, s.owner, s.ruleId)).toBe(true);
      expect(await covering(s.payer, s.owner, s.recipient, 3_000)).toEqual({ covered: false, reasons: [], paused: false });
    });
  });

  describe("moveWallet 钱包转入与收回", () => {
    async function payerWith(mainMinor: number) {
      const payer = await newCustomer(`付款人${suffix()}`);
      await setBalance(payer.accountId, mainMinor);
      return { payer, owner: await newOwner() };
    }

    it("转入：主账户减少、钱包增加，账务借贷平衡", async () => {
      const { payer, owner } = await payerWith(100_000);
      expect(await moveWallet(payer.id, owner, "in", 30_000)).toEqual({ ok: true, balanceMinor: 30_000 });
      const wallet = await walletOf(owner, payer.id);
      expect(await balanceOf(payer.accountId)).toBe(70_000);
      expect(await balanceOf(wallet)).toBe(30_000);
      const transactions = await ledgerTouching(wallet);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toHaveLength(2);
      expect(transactions[0]).toEqual(expect.arrayContaining([
        { accountId: payer.accountId, amount: -30_000, direction: "DEBIT" },
        { accountId: wallet, amount: 30_000, direction: "CREDIT" },
      ]));
      expect(sumOf(transactions[0])).toBe(0);
    });

    it("收回：钱包减少、主账户增加，账务借贷平衡", async () => {
      const { payer, owner } = await payerWith(100_000);
      expect(await moveWallet(payer.id, owner, "in", 30_000)).toEqual({ ok: true, balanceMinor: 30_000 });
      expect(await moveWallet(payer.id, owner, "out", 10_000)).toEqual({ ok: true, balanceMinor: 20_000 });
      const wallet = await walletOf(owner, payer.id);
      expect(await balanceOf(payer.accountId)).toBe(80_000);
      expect(await balanceOf(wallet)).toBe(20_000);
      const transactions = await ledgerTouching(wallet);
      expect(transactions).toHaveLength(2);
      for (const entries of transactions) {
        expect(entries).toHaveLength(2);
        expect(sumOf(entries)).toBe(0);
      }
      expect(transactions).toContainEqual(expect.arrayContaining([
        { accountId: wallet, amount: -10_000, direction: "DEBIT" },
        { accountId: payer.accountId, amount: 10_000, direction: "CREDIT" },
      ]));
    });

    it("钱包最多 ¥2,000：超过时拒绝且两边余额不变；恰好到上限则允许", async () => {
      const { payer, owner } = await payerWith(400_000);
      expect(await moveWallet(payer.id, owner, "in", 150_000)).toEqual({ ok: true, balanceMinor: 150_000 });
      const wallet = await walletOf(owner, payer.id);
      const before = [await balanceOf(payer.accountId), await balanceOf(wallet)];
      expect(await moveWallet(payer.id, owner, "in", 60_000)).toEqual({ ok: false, error: expect.stringContaining("钱包最多放 ¥2,000") });
      expect([await balanceOf(payer.accountId), await balanceOf(wallet)]).toEqual(before);
      expect(await moveWallet(payer.id, owner, "in", 50_000)).toEqual({ ok: true, balanceMinor: 200_000 });
      expect(await balanceOf(wallet)).toBe(200_000);
    });

    it("主账户余额不足时拒绝转入，两边余额都不变", async () => {
      const { payer, owner } = await payerWith(10_000);
      expect(await moveWallet(payer.id, owner, "in", 20_000)).toEqual({ ok: false, error: "主账户余额不足。" });
      expect(await balanceOf(payer.accountId)).toBe(10_000);
      expect(await balanceOf(await walletAccountOf(owner, payer.id))).toBe(0);
    });

    it("钱包余额不足时拒绝收回，两边余额都不变", async () => {
      const { payer, owner } = await payerWith(100_000);
      expect(await moveWallet(payer.id, owner, "in", 5_000)).toEqual({ ok: true, balanceMinor: 5_000 });
      expect(await moveWallet(payer.id, owner, "out", 6_000)).toEqual({ ok: false, error: "钱包里没有这么多。" });
      expect(await balanceOf(payer.accountId)).toBe(95_000);
      expect(await balanceOf(await walletAccountOf(owner, payer.id))).toBe(5_000);
    });

    it.each([0, -100, 1.5, Number.NaN, 2 ** 53])("金额 %s 不是正整数分：拒绝，余额不变", async amount => {
      const { payer, owner } = await payerWith(100_000);
      expect(await moveWallet(payer.id, owner, "in", amount)).toEqual({ ok: false, error: "金额必须大于 0。" });
      expect(await balanceOf(payer.accountId)).toBe(100_000);
    });

    it("同一访客换一位客户转入：钱记在那位客户自己的钱包里，不会记到前一位客户名下", async () => {
      const { payer, owner } = await payerWith(100_000);
      const other = await newCustomer(`另一位${suffix()}`);
      await setBalance(other.accountId, 100_000);
      expect(await moveWallet(payer.id, owner, "in", 30_000)).toEqual({ ok: true, balanceMinor: 30_000 });
      expect(await moveWallet(other.id, owner, "in", 20_000)).toEqual({ ok: true, balanceMinor: 20_000 });
      const payerWallet = await walletOf(owner, payer.id);
      const otherWallet = await walletOf(owner, other.id);
      expect(otherWallet).not.toBe(payerWallet);
      expect(await balanceOf(payerWallet)).toBe(30_000);
      expect(await balanceOf(otherWallet)).toBe(20_000);
      expect(await balanceOf(payer.accountId)).toBe(70_000);
      expect(await balanceOf(other.accountId)).toBe(80_000);
    });
  });

  describe("walletOverview 规矩与钱包页", () => {
    it("只返回本人的规矩和规矩内的成功转账，并给出数字与布尔值", async () => {
      const { payer, recipient, owner: me } = await parties();
      const other = await newOwner();
      await setBalance(payer.accountId, 1_000_000);
      expect(await moveWallet(payer.id, me, "in", 50_000)).toEqual({ ok: true, balanceMinor: 50_000 });

      const cooling = await proposeRule(payer, me, [recipient.name], 200, 800);
      await activate(cooling, new Date(DAY.getTime() - 24 * HOUR));
      const paused = await proposeRule(payer, me, [recipient.name]);
      await activate(paused, new Date(DAY.getTime() - 24 * HOUR));
      expect(await pauseRule(payer.id, me, paused)).toBe(true);
      const dismissed = await proposeRule(payer, me, [recipient.name]);
      expect(await dismissRule(payer.id, me, dismissed)).toBe(true);
      const draft = await proposeRule(payer, me, [recipient.name]);
      const theirs = await proposeRule(payer, other, [recipient.name]);
      await activate(theirs, new Date(DAY.getTime() - 24 * HOUR));

      await paidUnder(payer, recipient, cooling, 3_000, new Date(DAY.getTime() - HOUR));
      await paidUnder(payer, recipient, paused, 2_000, new Date(DAY.getTime() - 2 * HOUR));
      await paidUnder(payer, recipient, paused, 7_000, new Date(DAY.getTime() - 3 * HOUR), "FAILED");
      await paidUnder(payer, recipient, theirs, 9_000, new Date(DAY.getTime() - HOUR));
      await paidUnder(payer, recipient, null, 4_000, new Date(DAY.getTime() - HOUR));

      const overview = await walletOverview(payer.id, me);
      expect(overview.balanceMinor).toBe(50_000);
      expect(overview.caps).toEqual({ balanceMinor: WALLET_CAPS.balanceMinor, perTxnMinor: WALLET_CAPS.perTxnMinor, monthlyMinor: WALLET_CAPS.monthlyMinor });
      expect(overview.rules.map(rule => rule.id)).not.toContain(draft);
      expect(overview.rules.map(rule => rule.id).sort()).toEqual([cooling, paused].sort());
      expect(overview.rules.find(rule => rule.id === paused)?.pausedReason).toBe("你手动暂停");
      expect(overview.payments).toHaveLength(2);
      expect(overview.payments).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: cooling, amountMinor: 3_000, recipient: recipient.name }),
        expect.objectContaining({ ruleId: paused, amountMinor: 2_000, recipient: recipient.name }),
      ]));
      expect(typeof overview.auth.passkeys).toBe("number");
      expect(overview.auth.totp).toBe(false);
    });
  });
});
