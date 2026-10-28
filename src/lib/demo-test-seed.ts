import { query } from "./db";
import { DEMO_PROFILES } from "./demo-catalog";

// 仅供集成测试：删除演示种子数据（五位用户、清算账户、理财历史），让一次性数据库回到未种子状态。
export async function removeDemoSeed(extraCustomerIds: string[] = []) {
  const ids = (await query<{ customer_id: string }>("SELECT customer_id FROM demo_profiles WHERE profile_key=ANY($1::text[])", [DEMO_PROFILES.map((p) => p.key)])).rows.map((r) => r.customer_id);
  ids.push(...extraCustomerIds);
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
