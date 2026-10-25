import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { beginTotpSetup, confirmTotpSetup } from "./auth";
import { advanceInvestmentClock, cancelInvestment, commitInvestment, getInvestmentOrder, getInvestmentOverview, listInvestmentProducts, prepareInvestment, saveInvestmentAssessment } from "./investments";

function totp(secret: string, offset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(value => parseInt(value, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const hash = createHmac("sha1", key).update(counter).digest();
  return String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
const flexibleId = "02100000-0000-4000-8000-000000000001";
const holdingId = "02100000-0000-4000-8000-000000000003";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("simulated investment database boundaries", () => {
  const customers: string[] = [];
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test" || !process.env.PASSWORD_PEPPER) throw new Error("Use an isolated local bankpilot_test database and test pepper");
  });
  async function fixture() {
    const id = randomUUID(), account = randomUUID(); customers.push(id);
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Wealth test',$2)", [id, randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no,available_balance_minor) VALUES($1,$2,'Test','CHECKING','TEST',1000000)", [account, id]);
    await saveInvestmentAssessment(id, { answers: [3, 3, 3], confirmed: true });
    const { secret } = await beginTotpSetup(id);
    await confirmTotpSetup(id, totp(secret));
    const buy = (productId = flexibleId, amountMinor = 100000, key = randomUUID()) => prepareInvestment(id, { side: "SUBSCRIBE", productId, accountId: account, amountMinor, idempotencyKey: key });
    return { id, account, secret, buy };
  }
  afterAll(async () => {
    const ledgerIds = (await query<{ id: string }>("SELECT l.id FROM ledger_transactions l JOIN investment_orders o ON l.reference='LED-'||o.operation_id WHERE o.customer_id=ANY($1::uuid[])", [customers])).rows.map(row => row.id);
    await query(`UPDATE accounts a SET available_balance_minor=a.available_balance_minor-x.total FROM
      (SELECT account_id,sum(amount_minor) total FROM ledger_entries WHERE ledger_transaction_id=ANY($1::uuid[]) GROUP BY account_id) x
      WHERE a.id=x.account_id AND a.customer_id IS NULL`, [ledgerIds]);
    await query("DELETE FROM ledger_entries WHERE ledger_transaction_id=ANY($1::uuid[])", [ledgerIds]);
    await query("DELETE FROM ledger_transactions WHERE id=ANY($1::uuid[])", [ledgerIds]);
    for (const table of ["investment_orders", "investment_positions", "investment_simulation_clocks", "risk_assessments", "audit_events"]) await query(`DELETE FROM ${table} WHERE customer_id=ANY($1::uuid[])`, [customers]);
    await query("DELETE FROM bank_transactions WHERE account_id IN (SELECT id FROM accounts WHERE customer_id=ANY($1::uuid[]))", [customers]);
    await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
    await db.end();
  });

  it("loads six products and applies amount, risk and liquidity criteria", async () => {
    const user = await fixture();
    const catalog = await listInvestmentProducts(user.id);
    expect(catalog.products).toHaveLength(6);
    expect(new Set(catalog.products.map(product => product.kind)).size).toBe(3);
    expect((await listInvestmentProducts(user.id, { amountMinor: 10000, maximumRisk: "R1", maxHoldingDays: 0 })).products.map(product => product.id)).toEqual([flexibleId]);
    expect((await listInvestmentProducts(user.id, { amountMinor: 1 })).products).toHaveLength(0);
  });
  it("enforces suitability, minimum amounts, tenant ownership and no execution without MFA", async () => {
    const user = await fixture(), other = await fixture();
    await saveInvestmentAssessment(user.id, { answers: [1, 3, 3], confirmed: true });
    await expect(user.buy(holdingId)).rejects.toThrow("INVESTMENT_RISK_MISMATCH");
    await expect(user.buy(flexibleId, 99)).rejects.toThrow("INVESTMENT_MINIMUM_REQUIRED");
    await expect(prepareInvestment(user.id, { side: "SUBSCRIBE", productId: flexibleId, accountId: other.account, amountMinor: 10000, idempotencyKey: randomUUID() })).rejects.toThrow("ACCOUNT_NOT_FOUND");
    const draft = await user.buy();
    expect(await commitInvestment(user.id, draft.operationId)).toEqual({ authError: "AUTH_REQUIRED" });
    await expect(getInvestmentOrder(other.id, draft.operationId)).rejects.toThrow("OPERATION_NOT_FOUND");
    expect((await getInvestmentOverview(user.id)).positions).toHaveLength(0);
  });
  it("serializes duplicate submission, consumes the OTP once and balances the ledger", async () => {
    const user = await fixture(), key = randomUUID();
    const draft = await user.buy(flexibleId, 100000, key);
    expect((await user.buy(flexibleId, 100000, key)).operationId).toBe(draft.operationId);
    await expect(user.buy(flexibleId, 200000, key)).rejects.toThrow("AUTHORIZATION_MISMATCH");
    const results = await Promise.all([commitInvestment(user.id, draft.operationId, totp(user.secret, 1)), commitInvestment(user.id, draft.operationId, totp(user.secret, 1))]);
    expect(results[0]).toEqual(results[1]);
    expect((await getInvestmentOverview(user.id)).positions).toHaveLength(1);
    expect((await query("SELECT available_balance_minor FROM accounts WHERE id=$1", [user.account])).rows[0].available_balance_minor).toBe("900000");
    expect((await query("SELECT sum(e.amount_minor)::text AS total,count(*)::int AS count FROM ledger_entries e JOIN ledger_transactions l ON l.id=e.ledger_transaction_id WHERE l.reference=$1", [`LED-${draft.operationId}`])).rows[0]).toEqual({ total: "0", count: 2 });
    const next = await user.buy();
    expect(await commitInvestment(user.id, next.operationId, totp(user.secret, 1))).toEqual({ authError: "AUTH_INVALID" });
  });
  it("blocks locked redemption, advances only the customer's clock and redeems exactly once", async () => {
    const user = await fixture(), other = await fixture();
    const draft = await user.buy(holdingId);
    await commitInvestment(user.id, draft.operationId, totp(user.secret, 1));
    const before = await getInvestmentOverview(user.id), otherDate = (await getInvestmentOverview(other.id)).businessDate;
    const position = before.positions[0];
    const redeem = () => prepareInvestment(user.id, { side: "REDEEM", positionId: position.id, idempotencyKey: randomUUID() });
    await expect(redeem()).rejects.toThrow("INVESTMENT_LOCKED");
    const obsolete = await user.buy();
    await advanceInvestmentClock(user.id, 30, before.businessDate);
    await expect(advanceInvestmentClock(user.id, 30, before.businessDate)).rejects.toThrow("INVESTMENT_DATE_CHANGED");
    expect((await getInvestmentOverview(other.id)).businessDate).toBe(otherDate);
    expect((await getInvestmentOrder(user.id, obsolete.operationId)).status).toBe("CANCELLED");
    const after = await getInvestmentOverview(user.id);
    expect(after.positions[0].redeemable).toBe(true);
    expect(after.positions[0].valueMinor).not.toBe(position.valueMinor);
    const redemption = await redeem();
    const results = await Promise.all([commitInvestment(user.id, redemption.operationId), commitInvestment(user.id, redemption.operationId)]);
    expect(results[0]).toEqual(results[1]);
    expect((await getInvestmentOverview(user.id)).positions).toHaveLength(0);
    expect((await query("SELECT available_balance_minor FROM accounts WHERE id=$1", [user.account])).rows[0].available_balance_minor).toBe(String(900000 + redemption.quote.settlementMinor));
  });
  it("rejects changed authorization terms and cancelled or expired drafts", async () => {
    const user = await fixture();
    const cancelled = await user.buy();
    await cancelInvestment(user.id, cancelled.operationId);
    await expect(commitInvestment(user.id, cancelled.operationId, totp(user.secret, 1))).rejects.toThrow("OPERATION_NOT_EXECUTABLE");
    const expired = await user.buy();
    await query("UPDATE investment_orders SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [expired.operationId]);
    await expect(commitInvestment(user.id, expired.operationId, totp(user.secret, 1))).rejects.toThrow("AUTH_EXPIRED");
    const changed = await user.buy();
    await query("UPDATE investment_orders SET quote=jsonb_set(quote,'{amountMinor}','200000') WHERE operation_id=$1", [changed.operationId]);
    await expect(commitInvestment(user.id, changed.operationId, totp(user.secret, 1))).rejects.toThrow("AUTHORIZATION_MISMATCH");
    expect((await getInvestmentOverview(user.id)).positions).toHaveLength(0);
  });
});
