import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("013 to 014 authorization upgrade", () => {
  const databaseName = `bankpilot_auth_${randomUUID().replaceAll("-", "")}`;
  const migrationsDir = new URL("../../db/migrations/", import.meta.url);
  const customer = randomUUID(), recipient = randomUUID(), account = randomUUID(), target = randomUUID(), beneficiary = randomUUID();
  let isolated: Pool | undefined;
  let created = false;
  let migration: string;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test maintenance connection with CREATEDB");
    await db.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    created = true;
    url.pathname = `/${databaseName}`;
    isolated = new Pool({ connectionString: url.toString(), max: 1 });
    const versions = (await readdir(fileURLToPath(migrationsDir))).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
    for (const version of versions.filter(name => Number(name.slice(0, 3)) <= 13)) {
      await isolated.query(await readFile(new URL(version, migrationsDir), "utf8"));
    }
    await isolated.query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Payer',$3),($2,'Recipient',$4)", [customer, recipient, randomUUID(), randomUUID()]);
    await isolated.query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no,available_balance_minor) VALUES($1,$2,'Payer','CHECKING','1234',10000),($3,$4,'Recipient','CHECKING','5678',0)", [account, customer, target, recipient]);
    await isolated.query("INSERT INTO beneficiaries(id,customer_id,name,bank_name,masked_account,settlement_account_id,recipient_customer_id) VALUES($1,$2,'Recipient','BankPilot','5678',$3,$4)", [beneficiary, customer, target, recipient]);
    await isolated.query("INSERT INTO mfa_totp(customer_id,encrypted_secret,enabled_at) VALUES($1,'encrypted-fixture',now())", [customer]);
    await isolated.query("INSERT INTO transfers(operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,risk_level,required_auth,status,authorization_fingerprint) VALUES('OLD-PENDING','old-pending',$1,$2,$3,100,'YELLOW','CONFIRM','AWAITING_AUTH','old-hash'),('OLD-POSTED','old-posted',$1,$2,$3,100,'YELLOW','CONFIRM','SUCCEEDED','old-posted-hash')", [customer, account, beneficiary]);
    await isolated.query("INSERT INTO authorization_challenges(customer_id,operation_id,method,expires_at) VALUES($1,'OLD-PENDING','TOTP',now()+interval '10 minutes')", [customer]);
    migration = await readFile(new URL("019_authorization_hardening.sql", migrationsDir), "utf8");
    await isolated.query(migration);
  }, 30000);

  afterAll(async () => {
    if (isolated) await isolated.end();
    if (created) await db.query(`DROP DATABASE "${databaseName}"`);
    await db.end();
  });

  it("cancels and audits old drafts without deleting prior transfers, balances or MFA", async () => {
    const sql = isolated!;
    expect((await sql.query("SELECT status,failure_code FROM transfers WHERE operation_id='OLD-PENDING'")).rows[0]).toEqual({ status: "CANCELLED", failure_code: "AUTHORIZATION_V2_REQUIRED" });
    expect((await sql.query("SELECT status FROM authorization_challenges WHERE operation_id='OLD-PENDING'")).rows[0].status).toBe("CANCELLED");
    expect((await sql.query("SELECT status,authorization_fingerprint FROM transfers WHERE operation_id='OLD-POSTED'")).rows[0]).toEqual({ status: "SUCCEEDED", authorization_fingerprint: "old-posted-hash" });
    expect((await sql.query("SELECT available_balance_minor::text AS balance FROM accounts WHERE id=$1", [account])).rows[0].balance).toBe("10000");
    expect((await sql.query("SELECT encrypted_secret,last_used_step IS NOT NULL AS old_window_blocked FROM mfa_totp WHERE customer_id=$1", [customer])).rows[0]).toEqual({ encrypted_secret: "encrypted-fixture", old_window_blocked: true });
    expect((await sql.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type='TRANSFER_AUTH_INVALIDATED'")).rows[0].count).toBe(1);
    expect((await sql.query("SELECT bool_and(authorization_expires_at=prepared_at+interval '10 minutes') AS bound FROM transfers")).rows[0].bound).toBe(true);
  });

  it("can rerun without invalidating new drafts or duplicating audit records", async () => {
    const sql = isolated!;
    await sql.query("INSERT INTO transfers(operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,risk_level,required_auth,status,authorization_fingerprint) VALUES('NEW-PENDING','new-pending',$1,$2,$3,100,'YELLOW','CONFIRM','AWAITING_AUTH','new-hash')", [customer, account, beneficiary]);
    await sql.query(migration);
    expect((await sql.query("SELECT status FROM transfers WHERE operation_id='NEW-PENDING'")).rows[0].status).toBe("AWAITING_AUTH");
    expect((await sql.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type='TRANSFER_AUTH_INVALIDATED'")).rows[0].count).toBe(1);
    expect((await sql.query("SELECT count(*)::int AS count FROM schema_migrations WHERE version='019_authorization_hardening.sql'")).rows[0].count).toBe(1);
  });
});
