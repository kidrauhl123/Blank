import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateRequest, registerCustomer } from "./auth";
import { getBankingOverview } from "./bank-core";
import { DEMO_PROFILES } from "./demo-catalog";
import { ensureDemoProfiles, loginDemoProfile } from "./demo";
import { db, query } from "./db";
import { ensureDemoInvestmentHistory } from "./demo-investments";
import { getInvestmentOverview } from "./investments";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("fictional competition identities", () => {
  let sentinel: Awaited<ReturnType<typeof registerCustomer>>;
  let ownedSeed = false;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    if ((await query("SELECT 1 FROM demo_profiles")).rowCount) throw new Error("Demo integration needs an unseeded disposable database");
    ownedSeed = true;
    sentinel = await registerCustomer({ displayName: "Untouched customer", phone: randomUUID(), password: "Test-only-123456" });
  });
  afterAll(async () => {
    if (ownedSeed) {
      const ids = (await query<{ customer_id: string }>("SELECT customer_id FROM demo_profiles WHERE profile_key=ANY($1::text[])", [DEMO_PROFILES.map((p) => p.key)])).rows.map((r) => r.customer_id);
      if (sentinel) ids.push(sentinel.customer.id);
      const accountIds = (await query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=ANY($1::uuid[]) OR system_code='DEMO_SEED_CLEARING'", [ids])).rows.map((r) => r.id);
      await query(`UPDATE accounts a SET available_balance_minor=a.available_balance_minor-x.total FROM
        (SELECT e.account_id,sum(e.amount_minor) total FROM ledger_entries e JOIN ledger_transactions l ON l.id=e.ledger_transaction_id
         WHERE l.reference LIKE 'LED-DEMO-INV-%' GROUP BY e.account_id) x WHERE a.id=x.account_id AND a.system_code='INVESTMENT_CUSTODY'`);
      await query("DELETE FROM ledger_entries WHERE ledger_transaction_id IN (SELECT id FROM ledger_transactions WHERE reference LIKE 'DEMO-%' OR reference LIKE 'LED-DEMO-%')");
      await query("DELETE FROM ledger_transactions WHERE reference LIKE 'DEMO-%' OR reference LIKE 'LED-DEMO-%'");
      for (const table of ["investment_orders", "investment_positions", "investment_simulation_clocks"]) await query(`DELETE FROM ${table} WHERE customer_id=ANY($1::uuid[])`, [ids]);
      for (const table of ["audit_events", "subscriptions", "cards", "transfers", "beneficiaries", "demo_profiles"]) await query(`DELETE FROM ${table} WHERE customer_id=ANY($1::uuid[])`, [ids]);
      await query("DELETE FROM bank_transactions WHERE account_id=ANY($1::uuid[])", [accountIds]);
      await query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [ids]);
    }
    await db.end();
  });
  it("rejects arbitrary identities before seeding", async () => {
    for (const profileKey of ["tomato", sentinel.customer.id, "unknown"]) await expect(loginDemoProfile({ profileKey })).rejects.toThrow("DEMO_PROFILE_NOT_FOUND");
    expect((await query("SELECT 1 FROM demo_profiles")).rowCount).toBe(0);
  });
  it("concurrent initialization creates exactly five named users with usable history", async () => {
    await Promise.all([ensureDemoProfiles(), ensureDemoProfiles(), ensureDemoProfiles()]);
    const people = (await query<{ customer_id: string; display_name: string }>("SELECT d.customer_id,c.display_name FROM demo_profiles d JOIN customers c ON c.id=d.customer_id")).rows;
    expect(people.map((p) => p.display_name).sort()).toEqual(["小土豆", "小板栗", "小苹果", "小西瓜", "小橘子"].sort());
    for (const person of people) {
      const overview = await getBankingOverview(person.customer_id);
      expect(overview.totalMinor).toBeGreaterThan(0);
      expect(overview.cards).toHaveLength(2);
      expect(overview.subscriptions).toHaveLength(2);
      expect(overview.transactions).toHaveLength(17);
      expect(overview.transactions.some((t) => t.category === "转账")).toBe(true);
      expect(overview.transactions.every((t) => !t.merchant_name.includes("小番茄"))).toBe(true);
    }
  });
  it("historical transfers and balances are backed by balanced ledger entries", async () => {
    const unbalanced = await query("SELECT t.id FROM ledger_transactions t JOIN ledger_entries e ON e.ledger_transaction_id=t.id WHERE t.reference LIKE 'DEMO-%' OR t.reference LIKE 'LED-DEMO-%' GROUP BY t.id HAVING count(*)<>2 OR sum(e.amount_minor)<>0");
    expect(unbalanced.rows).toEqual([]);
    const mismatches = await query("SELECT a.id FROM accounts a JOIN demo_profiles d ON d.customer_id=a.customer_id JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id HAVING a.available_balance_minor<>sum(e.amount_minor)");
    expect(mismatches.rows).toEqual([]);
    expect((await query("SELECT t.id FROM transfers t JOIN ledger_transactions l ON l.transfer_id=t.id WHERE t.operation_id LIKE 'DEMO-TRF-%'")).rowCount).toBe(5);
  });
  it("links every preset investment receipt to one account transaction and a balanced ledger", async () => {
    const people = (await query<{ customer_id: string }>("SELECT customer_id FROM demo_profiles")).rows;
    const balances = () => query("SELECT id,available_balance_minor FROM accounts WHERE customer_id=ANY($1::uuid[]) ORDER BY id", [people.map(person => person.customer_id)]);
    const before = (await balances()).rows;
    await Promise.all([ensureDemoInvestmentHistory(), ensureDemoInvestmentHistory(), ensureDemoInvestmentHistory()]);
    expect((await balances()).rows).toEqual(before);
    for (const person of people) {
      const overview = await getBankingOverview(person.customer_id);
      const portfolio = await getInvestmentOverview(person.customer_id);
      expect(overview.transactions).toHaveLength(22);
      expect(portfolio.positions).toHaveLength(2);
      expect(portfolio.history).toHaveLength(4);
      for (const { receipt, executedAt } of portfolio.history) {
        const entries = overview.transactions.filter(transaction => transaction.metadata.operationId === receipt.operationId);
        expect(entries).toHaveLength(1);
        const transaction = entries[0];
        expect(transaction.investment_receipt).toEqual(receipt);
        expect(Number(transaction.amount_minor)).toBe(receipt.side === "SUBSCRIBE" ? -receipt.amountMinor : receipt.settlementMinor);
        expect(transaction.metadata.ledgerReference).toBe(receipt.ledgerReference);
        expect(new Date(transaction.occurred_at).toISOString()).toBe(executedAt);
        const ledger = await query<{ total: string; count: number; cash: string }>(`SELECT sum(e.amount_minor)::text AS total,count(*)::int AS count,
          sum(e.amount_minor) FILTER (WHERE e.account_id=$2)::text AS cash FROM ledger_transactions l
          JOIN ledger_entries e ON e.ledger_transaction_id=l.id WHERE l.reference=$1`, [receipt.ledgerReference, transaction.account_id]);
        expect(ledger.rows[0]).toEqual({ total: "0", count: 2, cash: String(transaction.amount_minor) });
      }
      expect(portfolio.history.filter(entry => entry.receipt.side === "REDEEM")).toHaveLength(1);
    }
    const after = (await balances()).rows;
    await ensureDemoInvestmentHistory();
    expect((await balances()).rows).toEqual(after);
    expect((await query("SELECT count(*)::int AS count FROM investment_orders WHERE suitability_evidence->>'source'='DEMO_SEED'")).rows[0].count).toBe(20);
    expect((await getInvestmentOverview(sentinel.customer.id)).positions).toEqual([]);
  });
  it("rotates real sessions and revokes the previous identity", async () => {
    const first = await loginDemoProfile({ profileKey: "potato" });
    const second = await loginDemoProfile({ profileKey: "chestnut", previousToken: first.token });
    const request = (token: string) => new Request("http://localhost/api/bootstrap", { headers: { cookie: `bankpilot_session=${token}` } });
    await expect(authenticateRequest(request(first.token))).rejects.toThrow();
    expect((await authenticateRequest(request(second.token))).customerId).toBe(second.customer.id);
    expect(second.customer.display_name).toBe("小板栗");
    expect(second.customer.id).not.toBe(first.customer.id);
  });
  it("re-entry preserves changed cards, existing data, and unrelated customers", async () => {
    const potato = await loginDemoProfile({ profileKey: "potato" });
    const before = await getBankingOverview(potato.customer.id);
    await query("UPDATE cards SET card_name='用户保留的名称' WHERE id=$1", [before.cards[0].id]);
    await loginDemoProfile({ profileKey: "potato" });
    const after = await getBankingOverview(potato.customer.id);
    expect(after.cards.find((c) => c.id === before.cards[0].id)?.card_name).toBe("用户保留的名称");
    expect(after.totalMinor).toBe(before.totalMinor);
    expect(after.transactions).toEqual(before.transactions);
    const unchanged = await getBankingOverview(sentinel.customer.id);
    expect(unchanged.customer.display_name).toBe("Untouched customer");
    expect(unchanged.totalMinor).toBe(0);
    expect(unchanged.transactions).toEqual([]);
    expect((await query("SELECT profile_key FROM demo_profiles")).rowCount).toBe(5);
  });
});
