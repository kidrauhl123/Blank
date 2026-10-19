import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTotpSetup, confirmTotpSetup, registerCustomer } from "./auth";
import { transferFingerprint } from "./transfer-binding";
import { commitTransfer, getOperation, prepareTransfer, recordDeposit } from "./bank-core";
import { db, query } from "./db";
import { readDailyTransferTotal } from "./transfer-quota";

function totp(secret: string, offset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(value => parseInt(value, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const digest = createHmac("sha1", key).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("transfer daily quota execution boundary", () => {
  const customers: string[] = [];
  const makeCustomer = async () => {
    const name = `Quota-${randomUUID()}`;
    const identity = await registerCustomer({ displayName: name, phone: randomUUID(), password: "Test-only-123456" });
    customers.push(identity.customer.id);
    const account = (await query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=$1", [identity.customer.id])).rows[0].id;
    return { id: identity.customer.id, account, name };
  };
  const pair = async (balance = 200000) => {
    const payer = await makeCustomer(), recipient = await makeCustomer();
    await recordDeposit(payer.id, { accountId: payer.account, amountMinor: balance, source: "CASH" });
    const prepare = (amountMinor: number, account = payer.account) => prepareTransfer(payer.id, { fromAccountId: account, recipient: recipient.name, amountMinor });
    return { payer, recipient, prepare };
  };
  const succeeded = async (id: string) => (await query<{ count: number; total: string }>(
    "SELECT count(*)::int AS count,coalesce(sum(amount_minor),0)::text AS total FROM transfers WHERE customer_id=$1 AND status='SUCCEEDED'", [id],
  )).rows[0];

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    if (!process.env.PASSWORD_PEPPER) throw new Error("Use a test-only PASSWORD_PEPPER");
  });
  afterAll(async () => {
    const ledger = await query<{ id: string }>(`SELECT id FROM ledger_transactions WHERE transfer_id IN
      (SELECT id FROM transfers WHERE customer_id=ANY($1::uuid[])) OR id IN
      (SELECT ledger_transaction_id FROM cash_deposits WHERE customer_id=ANY($1::uuid[]))`, [customers]);
    const ledgerIds = ledger.rows.map(row => row.id);
    // Restore shared clearing balances before deleting only our deposit entries.
    await query(`UPDATE accounts a SET available_balance_minor=a.available_balance_minor-x.total
      FROM (SELECT account_id,sum(amount_minor) AS total FROM ledger_entries WHERE ledger_transaction_id=ANY($1::uuid[]) GROUP BY account_id) x
      WHERE a.id=x.account_id AND a.customer_id IS NULL`, [ledgerIds]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM policy_decisions WHERE operation_id IN (SELECT operation_id FROM transfers WHERE customer_id=ANY($1::uuid[]))", [customers]);
    await query("DELETE FROM agent_runtime_runs WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM agent_threads WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM agent_tasks WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM authorization_challenges WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM cash_deposits WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM ledger_entries WHERE ledger_transaction_id=ANY($1::uuid[])", [ledgerIds]);
    await query("DELETE FROM ledger_transactions WHERE id=ANY($1::uuid[])", [ledgerIds]);
    await query("DELETE FROM transfers WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM beneficiaries WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM bank_transactions WHERE account_id IN (SELECT id FROM accounts WHERE customer_id=ANY($1::uuid[]))", [customers]);
    await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
    await db.end();
  });

  it("upgrades a pre-created second 600 CNY draft and requires a new explicit MFA submission", async () => {
    const { payer, prepare } = await pair();
    const first = await prepare(60000), second = await prepare(60000);
    expect([first.riskLevel, second.riskLevel]).toEqual(["YELLOW", "YELLOW"]);
    const { secret } = await beginTotpSetup(payer.id);
    await confirmTotpSetup(payer.id, totp(secret));
    await commitTransfer(payer.id, first.operationId, {});
    // Supplying a valid OTP with the stale yellow confirmation must still pause.
    expect(await commitTransfer(payer.id, second.operationId, { totpCode: totp(secret) })).toMatchObject({ authError: "AUTH_REQUIRED", riskLevel: "RED", requiredAuth: "MFA" });
    expect(await getOperation(payer.id, second.operationId)).toMatchObject({ status: "AWAITING_AUTH", riskLevel: "RED", requiredAuth: "MFA" });
    expect(await succeeded(payer.id)).toEqual({ count: 1, total: "60000" });
    const before = (await query("SELECT id,expires_at,attempts FROM authorization_challenges WHERE operation_id=$1", [second.operationId])).rows;
    expect(await commitTransfer(payer.id, second.operationId, {})).toMatchObject({ authError: "AUTH_REQUIRED" });
    expect((await query("SELECT id,expires_at,attempts FROM authorization_challenges WHERE operation_id=$1", [second.operationId])).rows).toEqual(before);
    expect(await commitTransfer(payer.id, second.operationId, { totpCode: totp(secret, 1) })).toMatchObject({ status: "SUCCEEDED" });
    expect(await succeeded(payer.id)).toEqual({ count: 2, total: "120000" });
    expect((await query("SELECT count(*)::int AS count FROM audit_events WHERE operation_id=$1 AND event_type='TRANSFER_AUTH_UPGRADED'", [second.operationId])).rows[0].count).toBe(1);
  });

  it("serializes concurrent submissions across two payer accounts", async () => {
    const { payer, prepare } = await pair();
    const extra = (await query<{ id: string }>("INSERT INTO accounts(customer_id,name,account_type,masked_no) VALUES($1,'Second','CHECKING','TEST') RETURNING id", [payer.id])).rows[0].id;
    await recordDeposit(payer.id, { accountId: extra, amountMinor: 200000, source: "CASH" });
    const drafts = await Promise.all([prepare(60000), prepare(60000, extra)]);
    const outcomes = await Promise.all(drafts.map(draft => commitTransfer(payer.id, draft.operationId, {})));
    expect(outcomes.filter(result => "authError" in result && result.authError === "AUTH_REQUIRED")).toHaveLength(1);
    expect(await succeeded(payer.id)).toEqual({ count: 1, total: "60000" });
    expect((await query("SELECT available_balance_minor::text AS balance FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY available_balance_minor", [[payer.account, extra]])).rows).toEqual([{ balance: "140000" }, { balance: "200000" }]);
  });

  it("allows exactly 1000 CNY but stops the next cent", async () => {
    const { payer, prepare } = await pair();
    const drafts = await Promise.all([prepare(50000), prepare(50000), prepare(1)]);
    await commitTransfer(payer.id, drafts[0].operationId, {});
    expect(await commitTransfer(payer.id, drafts[1].operationId, {})).toMatchObject({ status: "SUCCEEDED" });
    expect(await commitTransfer(payer.id, drafts[2].operationId, {})).toMatchObject({ authError: "AUTH_REQUIRED" });
    expect(await succeeded(payer.id)).toEqual({ count: 2, total: "100000" });
  });

  it("posts one receipt when the same operation is confirmed concurrently", async () => {
    const { payer, prepare } = await pair();
    const draft = await prepare(60000);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => commitTransfer(payer.id, draft.operationId, {})));
    expect(new Set(outcomes.map(result => "receipt" in result ? result.receipt?.id : null)).size).toBe(1);
    expect(await succeeded(payer.id)).toEqual({ count: 1, total: "60000" });
    expect((await query("SELECT count(*)::int AS count FROM ledger_entries WHERE ledger_transaction_id=(SELECT id FROM ledger_transactions WHERE reference=$1)", [`LED-${draft.operationId}`])).rows[0].count).toBe(2);
  });

  it("does not deadlock opposite-direction transfers", async () => {
    const { payer, recipient, prepare } = await pair();
    await recordDeposit(recipient.id, { accountId: recipient.account, amountMinor: 200000, source: "CASH" });
    const outgoing = await prepare(50000);
    const incoming = await prepareTransfer(recipient.id, { fromAccountId: recipient.account, recipient: payer.name, amountMinor: 50000 });
    const results = await Promise.all([commitTransfer(payer.id, outgoing.operationId, {}), commitTransfer(recipient.id, incoming.operationId, {})]);
    expect(results.map(result => result.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  }, 10000);

  it("excludes insufficient-funds attempts and rolls back a failed ledger write", async () => {
    const { payer, prepare } = await pair(100000);
    const stale = await prepare(50000), allowed = await prepare(90000);
    await commitTransfer(payer.id, allowed.operationId, {});
    await expect(commitTransfer(payer.id, stale.operationId, {})).rejects.toThrow("INSUFFICIENT_FUNDS");
    expect(await succeeded(payer.id)).toEqual({ count: 1, total: "90000" });
    const small = await prepare(5000);
    const injected = (await query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type) VALUES($1,'TEST') RETURNING id", [`LED-${small.operationId}`])).rows[0].id;
    try {
      await expect(commitTransfer(payer.id, small.operationId, {})).rejects.toMatchObject({ code: "23505" });
      expect(await getOperation(payer.id, small.operationId)).toMatchObject({ status: "AWAITING_AUTH" });
      expect(await succeeded(payer.id)).toEqual({ count: 1, total: "90000" });
      expect((await query("SELECT available_balance_minor::text AS balance FROM accounts WHERE id=$1", [payer.account])).rows[0].balance).toBe("10000");
    } finally { await query("DELETE FROM ledger_transactions WHERE id=$1", [injected]); }
    expect(await commitTransfer(payer.id, small.operationId, {})).toMatchObject({ status: "SUCCEEDED" });
  });

  it("uses Shanghai half-open execution-day boundaries in any database session zone", async () => {
    const { payer, prepare } = await pair();
    const times = ["2030-01-01T15:59:59.999Z", "2030-01-01T16:00:00Z", "2030-01-02T16:00:00Z"];
    for (let index = 0; index < times.length; index++) {
      const draft = await prepare((index + 1) * 11000);
      await commitTransfer(payer.id, draft.operationId, {});
      await query("UPDATE transfers SET executed_at=$2,prepared_at='2029-01-01T00:00:00Z' WHERE operation_id=$1", [draft.operationId, times[index]]);
    }
    const failed = await prepare(10000);
    await query("UPDATE transfers SET status='FAILED',executed_at='2030-01-01T16:00:00Z' WHERE operation_id=$1", [failed.operationId]);
    const client = await db.connect();
    try {
      for (const zone of ["UTC", "America/New_York", "Asia/Shanghai"]) {
        await client.query("SELECT set_config('TimeZone',$1,false)", [zone]);
        expect(await readDailyTransferTotal(payer.id, "2030-01-01T15:59:59.999Z", client)).toBe(11000);
        expect(await readDailyTransferTotal(payer.id, "2030-01-01T16:00:00Z", client)).toBe(22000);
        expect(await readDailyTransferTotal(payer.id, "2030-01-02T16:00:00Z", client)).toBe(33000);
      }
    } finally { await client.query("SET TIME ZONE DEFAULT"); client.release(); }
  });

  it("captures the posting instant after waiting for the payer lock", async () => {
    const { payer, prepare } = await pair();
    const draft = await prepare(10000);
    const locker = await db.connect();
    let pending: ReturnType<typeof commitTransfer> | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM customers WHERE id=$1 FOR NO KEY UPDATE", [payer.id]);
      pending = commitTransfer(payer.id, draft.operationId, {});
      const deadline = Date.now() + 8000;
      while (true) {
        const waiters = await locker.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM customers%'");
        if (waiters.rows[0].count) break;
        if (Date.now() > deadline) throw new Error("Commit did not wait on payer lock");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const released = (await locker.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0].at;
      await locker.query("COMMIT");
      expect(await pending).toMatchObject({ status: "SUCCEEDED" });
      expect((await query(`SELECT t.executed_at >= $2::timestamptz AS after_wait,t.executed_at=l.posted_at AS same_instant
        FROM transfers t JOIN ledger_transactions l ON l.transfer_id=t.id WHERE t.operation_id=$1`, [draft.operationId, released])).rows[0]).toEqual({ after_wait: true, same_instant: true });
    } finally { await locker.query("ROLLBACK"); locker.release(); if (pending) await pending; }
  }, 10000);

  it("does not refresh an expired upgraded challenge or downgrade its risk", async () => {
    const { payer, prepare } = await pair();
    const first = await prepare(60000), second = await prepare(60000);
    await commitTransfer(payer.id, first.operationId, {});
    await commitTransfer(payer.id, second.operationId, {});
    await query("UPDATE authorization_challenges SET expires_at=clock_timestamp()-interval '1 minute' WHERE operation_id=$1", [second.operationId]);
    await expect(commitTransfer(payer.id, second.operationId, {})).rejects.toThrow("AUTH_EXPIRED");
    expect((await query("SELECT count(*)::int AS count FROM authorization_challenges WHERE operation_id=$1", [second.operationId])).rows[0].count).toBe(1);
    expect(await getOperation(payer.id, second.operationId)).toMatchObject({ status: "AWAITING_AUTH", riskLevel: "RED", requiredAuth: "MFA" });
    expect(await succeeded(payer.id)).toEqual({ count: 1, total: "60000" });
  });

  it("keeps a draft red even when the prior transfers now belong to yesterday", async () => {
    const { payer, prepare } = await pair();
    const prior = await prepare(100000);
    await commitTransfer(payer.id, prior.operationId, {});
    const red = await prepare(1);
    expect(red.requiredAuth).toBe("MFA");
    await query("UPDATE transfers SET executed_at=now()-interval '2 days' WHERE operation_id=$1", [prior.operationId]);
    expect(await commitTransfer(payer.id, red.operationId, {})).toMatchObject({ authError: "AUTH_REQUIRED", riskLevel: "RED" });
  });

  it("updates a linked IM task to MFA without completing it", async () => {
    const { payer, prepare } = await pair();
    const first = await prepare(60000), second = await prepare(60000);
    const task = (await query<{ id: string }>("INSERT INTO agent_tasks(customer_id,user_utterance,intent,status,risk_level) VALUES($1,'Test transfer','TRANSFER','AWAITING_AUTH','YELLOW') RETURNING id", [payer.id])).rows[0].id;
    const thread = (await query<{ id: string }>("INSERT INTO agent_threads(customer_id,channel_type,external_conversation_hash) VALUES($1,'WECOM',$2) RETURNING id", [payer.id, randomUUID()])).rows[0].id;
    await query(`INSERT INTO agent_runtime_runs(agent_thread_id,customer_id,task_id,graph_thread_id,channel_type,status,interrupt_kind,operation_id,final_reply)
      VALUES($1,$2,$3,$4,'WECOM','INTERRUPTED','CONFIRM',$5,$6::jsonb)`, [thread, payer.id, task, randomUUID(), second.operationId, JSON.stringify({ message: "Yellow", operation: { operationId: second.operationId, type: "TRANSFER", riskLevel: "YELLOW", requiredAuth: "CONFIRM" } })]);
    await commitTransfer(payer.id, first.operationId, {});
    expect(await commitTransfer(payer.id, second.operationId, { taskId: task })).toMatchObject({ authError: "AUTH_REQUIRED" });
    expect((await query("SELECT status,risk_level FROM agent_tasks WHERE id=$1", [task])).rows[0]).toEqual({ status: "AWAITING_AUTH", risk_level: "RED" });
    expect((await query("SELECT status,interrupt_kind,final_reply FROM agent_runtime_runs WHERE task_id=$1", [task])).rows[0]).toMatchObject({ status: "INTERRUPTED", interrupt_kind: "MFA", final_reply: { operation: { riskLevel: "RED", requiredAuth: "MFA" } } });
  });

  it("does not let another customer confirm a transfer", async () => {
    const { payer, recipient, prepare } = await pair();
    const draft = await prepare(60000);
    await expect(commitTransfer(recipient.id, draft.operationId, {})).rejects.toThrow("OPERATION_NOT_FOUND");
    expect(await succeeded(payer.id)).toEqual({ count: 0, total: "0" });
  });

  it.each([
    ["amount", "UPDATE transfers SET amount_minor=amount_minor+1 WHERE operation_id=$1"],
    ["note", "UPDATE transfers SET note='changed' WHERE operation_id=$1"],
    ["expiry", "UPDATE transfers SET authorization_expires_at=authorization_expires_at+interval '1 hour' WHERE operation_id=$1"],
    ["recipient", "UPDATE beneficiaries SET name='Changed recipient' WHERE id=(SELECT beneficiary_id FROM transfers WHERE operation_id=$1)"],
  ])("rejects changed %s before posting or consuming MFA", async (_field, sql) => {
    const { payer, prepare } = await pair();
    const draft = await prepare(60000);
    await query(sql, [draft.operationId]);
    await expect(commitTransfer(payer.id, draft.operationId, {})).rejects.toThrow("AUTHORIZATION_MISMATCH");
    expect(await succeeded(payer.id)).toEqual({ count: 0, total: "0" });
    expect((await query("SELECT available_balance_minor::text AS balance FROM accounts WHERE id=$1", [payer.account])).rows[0].balance).toBe("200000");
  });

  it("rejects an expired correctly-bound yellow draft", async () => {
    const { payer, prepare } = await pair();
    const draft = await prepare(60000);
    // Simulate the server's original draft expiring without sleeping ten minutes.
    const row = (await query(`SELECT t.*,b.name,b.phone,b.masked_account,b.recipient_customer_id,b.settlement_account_id
      FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id WHERE t.operation_id=$1`, [draft.operationId])).rows[0];
    const expiresAt = new Date(Date.now() - 1000);
    const fingerprint = transferFingerprint({ operationId: draft.operationId, customerId: payer.id, source: row.from_account_id,
      target: row.settlement_account_id, recipientCustomerId: row.recipient_customer_id, recipientName: row.name,
      recipientPhone: row.phone, recipientMasked: row.masked_account, amountMinor: Number(row.amount_minor), currency: row.currency, note: row.note, expiresAt });
    await query("UPDATE transfers SET authorization_expires_at=$2,authorization_fingerprint=$3 WHERE operation_id=$1", [draft.operationId, expiresAt, fingerprint]);
    await expect(commitTransfer(payer.id, draft.operationId, {})).rejects.toThrow("AUTH_EXPIRED");
    expect(await succeeded(payer.id)).toEqual({ count: 0, total: "0" });
  });

  it("allows one concurrent transfer per TOTP step across different drafts", async () => {
    const { payer, prepare } = await pair(500000);
    const { secret } = await beginTotpSetup(payer.id);
    await confirmTotpSetup(payer.id, totp(secret));
    const drafts = await Promise.all([prepare(120000), prepare(120000)]);
    const code = totp(secret, 1);
    const results = await Promise.all(drafts.map(draft => commitTransfer(payer.id, draft.operationId, { totpCode: code })));
    expect(results.filter(result => "status" in result && result.status === "SUCCEEDED")).toHaveLength(1);
    expect(results.filter(result => "authError" in result && result.authError === "AUTH_INVALID")).toHaveLength(1);
    expect(await succeeded(payer.id)).toEqual({ count: 1, total: "120000" });
    // A network retry of the posted operation returns its receipt without OTP.
    const postedIndex = results.findIndex(result => "status" in result && result.status === "SUCCEEDED");
    expect(await commitTransfer(payer.id, drafts[postedIndex].operationId, { totpCode: code })).toMatchObject({ alreadyExecuted: true, status: "SUCCEEDED" });
  });

  it("shares the failure budget across drafts and enforces cooldown without consuming valid codes", async () => {
    const { payer, prepare } = await pair(500000);
    const { secret } = await beginTotpSetup(payer.id);
    await confirmTotpSetup(payer.id, totp(secret));
    const validCodes = new Set([-2, -1, 0, 1, 2].map(offset => totp(secret, offset)));
    let incorrect = 0;
    while (validCodes.has(String(incorrect).padStart(6, "0"))) incorrect++;
    const code = String(incorrect).padStart(6, "0");
    const results = [];
    for (let index = 0; index < 3; index++) {
      const draft = await prepare(120000);
      results.push(await commitTransfer(payer.id, draft.operationId, { totpCode: code }));
    }
    expect(results.map(result => "authError" in result ? result.authError : null)).toEqual(["AUTH_INVALID", "AUTH_INVALID", "AUTH_FUSE_ACTIVE"]);
    const fourth = await prepare(120000);
    const before = (await query("SELECT last_used_step FROM mfa_totp WHERE customer_id=$1", [payer.id])).rows[0];
    expect(await commitTransfer(payer.id, fourth.operationId, { totpCode: totp(secret, 1) })).toMatchObject({ authError: "AUTH_FUSE_ACTIVE" });
    expect((await query("SELECT last_used_step FROM mfa_totp WHERE customer_id=$1", [payer.id])).rows[0]).toEqual(before);
    await expect(beginTotpSetup(payer.id)).rejects.toThrow("AUTH_FUSE_ACTIVE");
    expect(await succeeded(payer.id)).toEqual({ count: 0, total: "0" });
    await query("UPDATE mfa_auth_state SET locked_until=clock_timestamp()-interval '1 second' WHERE customer_id=$1", [payer.id]);
    expect(await commitTransfer(payer.id, fourth.operationId, { totpCode: totp(secret, 1) })).toMatchObject({ status: "SUCCEEDED" });
    expect((await query("SELECT 1 FROM mfa_auth_state WHERE customer_id=$1", [payer.id])).rowCount).toBe(0);
  });

  it("rolls back TOTP consumption when posting fails", async () => {
    const { payer, prepare } = await pair(500000);
    const { secret } = await beginTotpSetup(payer.id);
    await confirmTotpSetup(payer.id, totp(secret));
    const draft = await prepare(120000);
    const before = (await query("SELECT last_used_step FROM mfa_totp WHERE customer_id=$1", [payer.id])).rows[0];
    // A duplicate ledger reference forces a failure after MFA consumption.
    await query("INSERT INTO ledger_transactions(reference,transaction_type) VALUES($1,'TEST')", [`LED-${draft.operationId}`]);
    try {
      await expect(commitTransfer(payer.id, draft.operationId, { totpCode: totp(secret, 1) })).rejects.toThrow();
      expect((await query("SELECT last_used_step FROM mfa_totp WHERE customer_id=$1", [payer.id])).rows[0]).toEqual(before);
      expect(await succeeded(payer.id)).toEqual({ count: 0, total: "0" });
    } finally { await query("DELETE FROM ledger_transactions WHERE reference=$1", [`LED-${draft.operationId}`]); }
    expect(await commitTransfer(payer.id, draft.operationId, { totpCode: totp(secret, 1) })).toMatchObject({ status: "SUCCEEDED" });
  });
});
