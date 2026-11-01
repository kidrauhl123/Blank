import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, authenticateRequest, createSession } from "./auth";
import { db, query } from "./db";
import { alertInboundRefunds, recordScamPhraseAlert } from "./fraud-store";

const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("新设备登录与反诈提醒（真实数据库）", () => {
  const customers: string[] = [];
  const accounts: string[] = [];
  async function newCustomer() {
    const customer = randomUUID(), account = randomUUID();
    if (new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1") throw new Error("Use an isolated local database");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Fraud alert test',$2)", [customer, randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Alert','CHECKING','TEST')", [account, customer]);
    customers.push(customer);
    accounts.push(account);
    return { customer, account };
  }
  const cookieRequest = (token: string) => new Request("http://localhost/api/v1/transfers/prepare", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  const feedCount = async (customer: string, dedupeKey: string) =>
    (await query("SELECT 1 FROM feed_posts WHERE customer_id=$1 AND dedupe_key=$2", [customer, dedupeKey])).rowCount ?? 0;

  afterAll(async () => {
    // Only fixture IDs are removed; this suite never truncates tables.
    await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM feed_publisher_state WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM bank_transactions WHERE account_id=ANY($1::uuid[])", [accounts]);
    await query("DELETE FROM user_sessions WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customer_devices WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accounts]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
    await db.end();
  });

  it("同一位客户第一次从第二台设备登录，这次会话标记为新设备；同一台设备再登录不标记", async () => {
    const { customer } = await newCustomer();
    const first = await createSession(customer, WINDOWS_CHROME);
    const second = await createSession(customer, IOS_SAFARI);
    const third = await createSession(customer, IOS_SAFARI);
    expect((await authenticateRequest(cookieRequest(first.token))).newDevice).toBe(false);
    expect((await authenticateRequest(cookieRequest(second.token))).newDevice).toBe(true);
    expect((await authenticateRequest(cookieRequest(third.token))).newDevice).toBe(false);
  });

  it("陌生商户的小额退款入账：留一条反诈守护的动态，只提醒一次", async () => {
    const { customer, account } = await newCustomer();
    const tx = await query<{ id: string }>("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'某平台退款','退款',1500,now()) RETURNING id", [account]);
    expect(await alertInboundRefunds(customer)).toBe(1);
    expect(await feedCount(customer, `inbound-alert:${tx.rows[0].id}`)).toBe(1);
    expect(await alertInboundRefunds(customer)).toBe(0);
    expect((await query("SELECT count(*)::int AS n FROM audit_events WHERE customer_id=$1 AND event_type='FRAUD_GUARD_INBOUND_ALERT'", [customer])).rows[0].n).toBe(1);
  });

  it("以前有过往来的商户、超过 300 元的入账，都不提醒", async () => {
    const { customer, account } = await newCustomer();
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'老店','餐饮',-800,now() - interval '2 days')", [account]);
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'老店','退款',500,now())", [account]);
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'陌生退款','退款',50000,now())", [account]);
    expect(await alertInboundRefunds(customer)).toBe(0);
  });

  it("对话或 IM 里的诈骗话术：留一条动态，同一条消息不重复记录", async () => {
    const { customer } = await newCustomer();
    await recordScamPhraseAlert({ customerId: customer, ownerId: null, source: "IM", phrase: "安全账户", dedupeKey: "im:event-1" });
    await recordScamPhraseAlert({ customerId: customer, ownerId: null, source: "IM", phrase: "安全账户", dedupeKey: "im:event-1" });
    expect(await feedCount(customer, "scam-phrase:im:event-1")).toBe(1);
    expect((await query("SELECT count(*)::int AS n FROM audit_events WHERE customer_id=$1 AND event_type='FRAUD_GUARD_PHRASE_WARNED'", [customer])).rows[0].n).toBe(1);
  });
});
