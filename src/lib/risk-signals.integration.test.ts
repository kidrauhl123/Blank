import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query, withTransaction } from "./db";
import { transferRiskSignals } from "./fraud-store";
import { evaluateTransferRisk } from "./policy";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("交易风险信号的服务端来源（真实数据库）", () => {
  const customer = randomUUID();
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Risk signal test',$2)", [customer, randomUUID()]);
  });
  afterAll(async () => {
    // Only fixture IDs are removed; this suite never truncates tables.
    await query("DELETE FROM audit_events WHERE customer_id=$1", [customer]);
    await query("DELETE FROM customers WHERE id=$1", [customer]);
    await db.end();
  });

  it("最近 30 分钟内被拒绝的强验证计入失败次数，更早的不计入", async () => {
    await query(`INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary,evidence,created_at) VALUES
      ($1,'MFA_REJECTED','RISK_ENGINE','验证失败','{}'::jsonb, now() - interval '5 minutes'),
      ($1,'MFA_REJECTED','RISK_ENGINE','验证失败','{}'::jsonb, now() - interval '6 minutes'),
      ($1,'MFA_REJECTED','RISK_ENGINE','验证失败','{}'::jsonb, now() - interval '40 minutes')`, [customer]);
    expect(await withTransaction(client => transferRiskSignals(client, customer, { now: new Date() }))).toEqual({ trustedDevice: true, failedAuthAttempts: 2 });
  });

  it("新设备登录的会话让这笔转账不可信，没有会话的渠道按可信处理", async () => {
    expect(await withTransaction(client => transferRiskSignals(client, customer, { newDevice: true, now: new Date() }))).toMatchObject({ trustedDevice: false });
    expect(await withTransaction(client => transferRiskSignals(client, customer, { now: new Date() }))).toMatchObject({ trustedDevice: true });
    expect(evaluateTransferRisk({ amountMinor: 1000, dailyTotalMinor: 0, trustedBeneficiary: true, trustedDevice: false }))
      .toMatchObject({ finalLevel: "RED", requiredAuth: "MFA", matchedRules: expect.arrayContaining(["UNTRUSTED_DEVICE"]) });
  });

  it("失败达到三次，即使金额很小也要强验证", async () => {
    await query(`INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary,evidence,created_at) VALUES
      ($1,'MFA_REJECTED','RISK_ENGINE','验证失败','{}'::jsonb, now() - interval '1 minute')`, [customer]);
    const signals = await withTransaction(client => transferRiskSignals(client, customer, { now: new Date() }));
    expect(signals.failedAuthAttempts).toBe(3);
    expect(evaluateTransferRisk({ amountMinor: 100, dailyTotalMinor: 0, trustedBeneficiary: true, ...signals }))
      .toMatchObject({ finalLevel: "RED", matchedRules: expect.arrayContaining(["AUTH_FAILURE_FUSE_ACTIVE"]) });
  });

  it("别的客户的拒绝记录不计入这位客户的次数", async () => {
    const other = randomUUID();
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Other',$2)", [other, randomBytes(6).toString("hex")]);
    try {
      expect(await withTransaction(client => transferRiskSignals(client, other, { now: new Date() }))).toEqual({ trustedDevice: true, failedAuthAttempts: 0 });
    } finally {
      await query("DELETE FROM customers WHERE id=$1", [other]);
    }
  });
});
