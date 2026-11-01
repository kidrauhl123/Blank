import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentReply, ModelMeta } from "./agent";
import { executePlannedAgent } from "./agent";
import type { AgentUnderstanding } from "./ai";
import { registerCustomer } from "./auth";
import { query } from "./db";

const PASSWORD = "Test-only-123456";
const meta: ModelMeta = { model: "fixture", promptTokens: null, completionTokens: null };
const transferUnderstanding = (payeePhone: string, amountMinor: number): AgentUnderstanding => ({
  intent: "TRANSFER",
  confidence: 0.99,
  entities: { beneficiaryName: payeePhone, amountMinor, accountName: null, timeRange: null },
  steps: ["parse_transfer", "policy_check"],
  clarification: null,
});

const created: string[] = [];
async function newCustomer(displayName: string) {
  const phone = `18${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
  const identity = await registerCustomer({ displayName, phone, password: PASSWORD });
  created.push(identity.customer.id);
  const account = (await query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=$1 AND account_type='CHECKING'", [identity.customer.id])).rows[0];
  return { id: identity.customer.id, phone, accountId: account.id };
}
async function matchedRules(reply: AgentReply) {
  const row = await query<{ matched_rules: string[] }>("SELECT matched_rules FROM policy_decisions WHERE operation_id=$1", [reply.operation!.operationId]);
  return row.rows[0].matched_rules;
}
async function cleanup() {
  if (created.length === 0) return;
  // 只删本文件创建的客户及其关联记录；不清空任何表。
  await query("DELETE FROM policy_decisions WHERE operation_id IN (SELECT operation_id FROM transfers WHERE customer_id=ANY($1::uuid[]))", [created]);
  await query("DELETE FROM authorization_challenges WHERE customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM transfers WHERE customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM agent_tasks WHERE customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM beneficiaries WHERE customer_id=ANY($1::uuid[]) OR recipient_customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM channel_outbox WHERE customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [created]);
  await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [created]);
}

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("聊天转账也带上设备信息（真实数据库）", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("新设备上发起的聊天转账和 App 表单一样：未知设备升为红色，大额进入反诈暂缓；没有会话的渠道不标记", async () => {
    const payer = await newCustomer("聊天转账付款人");
    const payee = await newCustomer("聊天转账收款人");
    await query("UPDATE accounts SET available_balance_minor=$2 WHERE id=$1", [payer.accountId, 1_000_000]);

    const fromNewDevice = await executePlannedAgent(payer.id, "给收款人转 3000 元", transferUnderstanding(payee.phone, 300_000), meta, { newDevice: true });
    const fromKnownChannel = await executePlannedAgent(payer.id, "给收款人转 3000 元", transferUnderstanding(payee.phone, 300_000), meta);

    expect(fromNewDevice.operation).toMatchObject({ riskLevel: "RED" });
    expect(await matchedRules(fromNewDevice)).toEqual(expect.arrayContaining(["UNTRUSTED_DEVICE", "FRAUD_GUARD_HOLD"]));
    expect(await matchedRules(fromKnownChannel)).not.toContain("UNTRUSTED_DEVICE");
  });
});
