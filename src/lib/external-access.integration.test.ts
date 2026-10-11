import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db";

// The supplied database is maintenance only. All fixtures and migrations live
// in this suite's separate database, which is dropped after closing its pool.
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("external access retirement migration", () => {
  const databaseName = `bankpilot_external_${randomUUID().replaceAll("-", "")}`;
  const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  const customerIds = [randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID()];
  const sessionIds = [randomUUID(), randomUUID()];
  const clientIds = [randomUUID(), randomUUID()];
  const tokenIds = [randomUUID(), randomUUID()];
  const historyIds = [randomUUID(), randomUUID()];
  const taskIds = [randomUUID(), randomUUID(), randomUUID()];
  const threadIds = [randomUUID(), randomUUID(), randomUUID()];
  const runIds = [randomUUID(), randomUUID(), randomUUID()];
  const graphThreadIds = [randomUUID(), randomUUID(), randomUUID()];
  const operationId = `TRF-${randomUUID()}`;
  let createdDatabase = false;
  let isolated: Pool;
  let migration: string;
  let bankBefore: Record<string, unknown>;

  async function bankSnapshot() {
    const tables = ["customers", "auth_credentials", "accounts", "user_sessions", "beneficiaries", "transfers", "ledger_transactions", "ledger_entries", "bank_transactions", "audit_events", "langgraph.checkpoints"];
    const snapshot: Record<string, unknown> = {};
    for (const table of tables) {
      // Table names are a fixed internal allowlist; no user input is interpolated.
      snapshot[table] = (await isolated.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return snapshot;
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") {
      throw new Error("Use an isolated local bankpilot_test maintenance connection with CREATEDB");
    }
    if (!/^bankpilot_external_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unsafe fixture database name");
    await db.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    createdDatabase = true;
    url.pathname = `/${databaseName}`;
    isolated = new Pool({ connectionString: url.toString(), max: 1 });
    const versions = (await readdir(migrationsDir)).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
    for (const version of versions.filter(name => Number(name.slice(0, 3)) <= 12)) {
      await isolated.query(await readFile(join(migrationsDir, version), "utf8"));
    }
    migration = await readFile(join(migrationsDir, "013_retire_external_access.sql"), "utf8");

    for (let index = 0; index < 2; index++) {
      await isolated.query("INSERT INTO customers(id,display_name,phone) VALUES($1,$2,$3)", [customerIds[index], `Retirement-${index}`, randomUUID()]);
      await isolated.query("INSERT INTO auth_credentials(customer_id,password_salt,password_hash) VALUES($1,'test-only','test-only')", [customerIds[index]]);
      await isolated.query(`INSERT INTO accounts(id,customer_id,name,account_type,masked_no,available_balance_minor)
        VALUES($1,$2,'Fixture','CHECKING','TEST',$3)`, [accountIds[index], customerIds[index], index === 0 ? 99000 : 1000]);
      await isolated.query(`INSERT INTO user_sessions(id,customer_id,token_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '1 day')`, [sessionIds[index], customerIds[index], randomUUID()]);
      await isolated.query("INSERT INTO api_clients(id,customer_id,name,client_id) VALUES($1,$2,'Old external client',$3)", [clientIds[index], customerIds[index], `external-${randomUUID()}`]);
      await isolated.query(`INSERT INTO api_tokens(id,client_id,customer_id,token_prefix,token_hash,scopes,expires_at)
        VALUES($1,$2,$3,'bpt_fixture',$4,ARRAY['accounts:read'],now()+interval '1 day')`, [tokenIds[index], clientIds[index], customerIds[index], randomUUID()]);
      await isolated.query(`INSERT INTO mcp_invocations(id,customer_id,client_id,tool_name,input_summary,outcome,operation_id)
        VALUES($1,$2,$3,'read_balance',$4::jsonb,'SUCCEEDED',$5)`, [historyIds[index], customerIds[index], clientIds[index], JSON.stringify({ fixtureCustomerId: customerIds[index] }), operationId]);
    }

    const beneficiaryId = randomUUID(), transferId = randomUUID(), ledgerId = randomUUID();
    await isolated.query(`INSERT INTO beneficiaries(id,customer_id,name,bank_name,masked_account,settlement_account_id,recipient_customer_id)
      VALUES($1,$2,'Recipient','BankPilot','TEST',$3,$4)`, [beneficiaryId, customerIds[0], accountIds[1], customerIds[1]]);
    await isolated.query(`INSERT INTO transfers(id,operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,risk_level,required_auth,status,authorization_fingerprint,executed_at)
      VALUES($1,$2,$2,$3,$4,$5,1000,'YELLOW','CONFIRM','SUCCEEDED','fixture-fingerprint',now())`, [transferId, operationId, customerIds[0], accountIds[0], beneficiaryId]);
    await isolated.query(`INSERT INTO ledger_transactions(id,reference,transfer_id,transaction_type)
      VALUES($1,$2,$3,'TRANSFER')`, [ledgerId, `LED-${operationId}`, transferId]);
    await isolated.query(`INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction)
      VALUES($1,$2,-1000,'DEBIT'),($1,$3,1000,'CREDIT')`, [ledgerId, accountIds[0], accountIds[1]]);
    await isolated.query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at)
      VALUES($1,'Fixture recipient','转账',-1000,now()),($2,'Fixture payer','转账',1000,now())`, accountIds);
    await isolated.query(`INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary,operation_id)
      VALUES($1,'TRANSFER_SUCCEEDED','BANK_CORE','Fixture completed transfer',$2)`, [customerIds[0], operationId]);

    for (let index = 0; index < 3; index++) {
      const status = ["RUNNING", "INTERRUPTED", "COMPLETED"][index];
      await isolated.query(`INSERT INTO agent_tasks(id,customer_id,user_utterance,intent,status,risk_level)
        VALUES($1,$2,'Historical external request','TRANSFER',$3,'YELLOW')`, [taskIds[index], customerIds[0], index === 2 ? "SUCCEEDED" : "AWAITING_AUTH"]);
      await isolated.query(`INSERT INTO agent_threads(id,customer_id,channel_type,external_conversation_hash)
        VALUES($1,$2,'MCP',$3)`, [threadIds[index], customerIds[0], randomUUID()]);
      await isolated.query(`INSERT INTO agent_runtime_runs(id,agent_thread_id,customer_id,task_id,graph_thread_id,channel_type,status,interrupt_kind,operation_id,final_reply,completed_at)
        VALUES($1,$2,$3,$4,$5,'MCP',$6,$7,$8,$9::jsonb,CASE WHEN $6='COMPLETED' THEN now() ELSE NULL END)`,
      [runIds[index], threadIds[index], customerIds[0], taskIds[index], graphThreadIds[index], status, index === 1 ? "CONFIRM" : null, operationId,
        JSON.stringify({ message: "Historical external request", operation: { operationId, type: "TRANSFER", riskLevel: "YELLOW", requiredAuth: "CONFIRM" } })]);
      await isolated.query(`INSERT INTO langgraph.checkpoints(thread_id,checkpoint_id,checkpoint,metadata)
        VALUES($1,$2,$3::jsonb,$4::jsonb)`, [graphThreadIds[index], randomUUID(), JSON.stringify({ fixture: true }), JSON.stringify({ customerId: customerIds[0], channel: "MCP" })]);
    }
    bankBefore = await bankSnapshot();
    await isolated.query(migration);
  }, 30000);

  afterAll(async () => {
    try {
      if (isolated) await isolated.end();
      if (createdDatabase) await db.query(`DROP DATABASE "${databaseName}"`);
    } finally { await db.end(); }
  });

  it("removes live names and preserves retired credentials and customer-scoped history", async () => {
    expect((await isolated.query(`SELECT to_regclass('public.api_tokens') AS tokens,
      to_regclass('public.api_clients') AS clients,to_regclass('public.mcp_invocations') AS invocations`)).rows[0])
      .toEqual({ tokens: null, clients: null, invocations: null });
    const tokens = (await isolated.query("SELECT id,client_id,customer_id,revoked_at IS NOT NULL AS revoked,expires_at<=now() AS expired FROM retired_api_tokens ORDER BY id")).rows;
    expect(tokens).toHaveLength(2);
    for (let index = 0; index < 2; index++) {
      expect(tokens).toContainEqual({ id: tokenIds[index], client_id: clientIds[index], customer_id: customerIds[index], revoked: true, expired: true });
      const history = (await isolated.query(`SELECT h.id,h.customer_id,h.client_id,c.status,t.id AS token_id
        FROM external_access_history h JOIN retired_api_clients c ON c.id=h.client_id
        JOIN retired_api_tokens t ON t.client_id=c.id WHERE h.customer_id=$1`, [customerIds[index]])).rows;
      expect(history).toEqual([{ id: historyIds[index], customer_id: customerIds[index], client_id: clientIds[index], status: "REVOKED", token_id: tokenIds[index] }]);
    }
  });

  it("retains the original foreign keys after renaming their target tables", async () => {
    const foreignKeys = (await isolated.query(`SELECT conrelid::regclass::text AS source,confrelid::regclass::text AS target
      FROM pg_constraint WHERE contype='f' AND conrelid IN ('retired_api_tokens'::regclass,'external_access_history'::regclass)`)).rows;
    expect(foreignKeys).toEqual(expect.arrayContaining([
      { source: "retired_api_tokens", target: "retired_api_clients" },
      { source: "retired_api_tokens", target: "customers" },
      { source: "external_access_history", target: "retired_api_clients" },
      { source: "external_access_history", target: "customers" },
    ]));
  });

  it("leaves customers, accounts, sessions, completed transfers and double-entry banking records unchanged", async () => {
    expect(await bankSnapshot()).toEqual(bankBefore);
    expect((await isolated.query("SELECT count(*)::int AS entries,sum(amount_minor)::text AS total FROM ledger_entries")).rows[0])
      .toEqual({ entries: 2, total: "0" });
  });

  it("cancels unfinished MCP runs and linked tasks, closes threads, and retains completed history", async () => {
    for (let index = 0; index < 3; index++) {
      expect((await isolated.query("SELECT status FROM agent_threads WHERE id=$1", [threadIds[index]])).rows[0]).toEqual({ status: "CLOSED" });
      expect((await isolated.query("SELECT status,completed_at IS NOT NULL AS completed FROM agent_runtime_runs WHERE id=$1", [runIds[index]])).rows[0])
        .toEqual({ status: index === 2 ? "COMPLETED" : "CANCELLED", completed: true });
      expect((await isolated.query("SELECT status FROM agent_tasks WHERE id=$1", [taskIds[index]])).rows[0])
        .toEqual({ status: index === 2 ? "SUCCEEDED" : "CANCELLED" });
    }
  });

  it("rejects new retired-channel rows and attempts to reactivate old clients or tokens", async () => {
    await expect(isolated.query(`INSERT INTO agent_threads(customer_id,channel_type,external_conversation_hash)
      VALUES($1,'MCP',$2)`, [customerIds[0], randomUUID()])).rejects.toMatchObject({ code: "23514" });
    await expect(isolated.query(`INSERT INTO agent_runtime_runs(agent_thread_id,customer_id,graph_thread_id,channel_type,status)
      VALUES($1,$2,$3,'MCP','RUNNING')`, [threadIds[0], customerIds[0], randomUUID()])).rejects.toMatchObject({ code: "23514" });
    await expect(isolated.query("UPDATE agent_threads SET status='ACTIVE' WHERE id=$1", [threadIds[0]])).rejects.toMatchObject({ code: "23514" });
    await expect(isolated.query("UPDATE agent_runtime_runs SET status='RUNNING' WHERE id=$1", [runIds[0]])).rejects.toMatchObject({ code: "23514" });
    await expect(isolated.query("UPDATE retired_api_clients SET status='ACTIVE' WHERE id=$1", [clientIds[0]])).rejects.toMatchObject({ code: "23514" });
    await expect(isolated.query("UPDATE retired_api_tokens SET revoked_at=NULL WHERE id=$1", [tokenIds[0]])).rejects.toMatchObject({ code: "23514" });
    await expect(isolated.query(`INSERT INTO retired_api_clients(customer_id,name,client_id)
      VALUES($1,'New live client',$2)`, [customerIds[0], randomUUID()])).rejects.toMatchObject({ code: "23514" });
    await expect(isolated.query(`INSERT INTO retired_api_tokens(client_id,customer_id,token_prefix,token_hash,scopes,expires_at)
      VALUES($1,$2,'new',$3,ARRAY['accounts:read'],now()+interval '1 day')`, [clientIds[0], customerIds[0], randomUUID()])).rejects.toMatchObject({ code: "23514" });
  });

  it("continues to accept owned bank and official IM threads", async () => {
    for (const channel of ["PWA", "QQ", "WECOM"]) {
      const thread = (await isolated.query(`INSERT INTO agent_threads(customer_id,channel_type,external_conversation_hash)
        VALUES($1,$2,$3) RETURNING id`, [customerIds[0], channel, randomUUID()])).rows[0];
      expect((await isolated.query(`INSERT INTO agent_runtime_runs(agent_thread_id,customer_id,graph_thread_id,channel_type,status)
        VALUES($1,$2,$3,$4,'RUNNING') RETURNING channel_type`, [thread.id, customerIds[0], randomUUID(), channel])).rows[0])
        .toEqual({ channel_type: channel });
    }
  });

  it("preserves every historical row and closed MCP row when migration 013 runs again", async () => {
    const tables = ["retired_api_tokens", "retired_api_clients", "external_access_history", "agent_tasks", "agent_threads", "agent_runtime_runs"];
    const before: Record<string, unknown> = {};
    for (const table of tables) before[table] = (await isolated.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    await isolated.query(migration);
    for (const table of tables) expect((await isolated.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows).toEqual(before[table]);
    expect(await bankSnapshot()).toEqual(bankBefore);
    expect((await isolated.query("SELECT count(*)::int AS count FROM schema_migrations WHERE version='013_retire_external_access.sql'")).rows[0]).toEqual({ count: 1 });
  });
});
