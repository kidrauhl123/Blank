import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("visitor memory migration", () => {
  const databaseName = `bankpilot_memory_${randomUUID().replaceAll("-", "")}`;
  const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  let isolated: Pool;
  let createdDatabase = false;
  const customerId = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test maintenance connection with CREATEDB");
    if (!/^bankpilot_memory_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unsafe fixture database name");
    await db.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    createdDatabase = true;
    url.pathname = `/${databaseName}`;
    isolated = new Pool({ connectionString: url.toString(), max: 1 });
    const versions = (await readdir(migrationsDir)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
    for (const version of versions) await isolated.query(await readFile(join(migrationsDir, version), "utf8"));
    await isolated.query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Demo','memory-fixture')", [customerId]);
    await isolated.query("INSERT INTO demo_profiles(profile_key,customer_id) VALUES('memory-fixture',$1)", [customerId]);
    await isolated.query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2),($3,$4)", [ownerA, "a".repeat(64), ownerB, "b".repeat(64)]);
    await isolated.query("INSERT INTO visitor_memory_scopes(owner_id,profile_key) VALUES($1,'memory-fixture'),($2,'memory-fixture')", [ownerA, ownerB]);
  });

  afterAll(async () => {
    try {
      if (isolated) await isolated.end();
      if (createdDatabase) {
        if (!/^bankpilot_memory_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unsafe fixture database name");
        // Pool.end() must release every fixture connection. A plain DROP makes
        // leaked clients visible instead of terminating them after the test.
        await db.query(`DROP DATABASE "${databaseName}"`);
      }
    } finally { await db.end(); }
  });

  it("keeps a separate preference row for each visitor on the same demo profile", async () => {
    await isolated.query(`INSERT INTO visitor_memory_preferences(owner_id,profile_key,preference_key,preference_value,source_kind,expires_at)
      VALUES($1,'memory-fixture','response_detail','brief','USER_EXPLICIT',now()+interval '90 days'),
            ($2,'memory-fixture','response_detail','detailed','USER_EXPLICIT',now()+interval '90 days')`, [ownerA, ownerB]);
    const rows = (await isolated.query("SELECT owner_id,preference_value FROM visitor_memory_preferences ORDER BY owner_id")).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.owner_id === ownerA)?.preference_value).toBe("brief");
    expect(rows.find((row) => row.owner_id === ownerB)?.preference_value).toBe("detailed");
  });

  it("rejects unsupported keys, values, and invalid expiry at the database boundary", async () => {
    const insert = (key: string, value: string, expiry: string) => isolated.query(
      `INSERT INTO visitor_memory_preferences(owner_id,profile_key,preference_key,preference_value,source_kind,expires_at)
       VALUES($1,'memory-fixture',$2,$3,'USER_EXPLICIT',now()+($4::interval))`, [ownerA, key, value, expiry],
    );
    await expect(insert("transfer_without_confirmation", "true", "90 days")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("response_language", "unsupported", "90 days")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("preferred_name", "x".repeat(41), "90 days")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("preferred_name", "Valid", "-1 day")).rejects.toMatchObject({ code: "23514" });
  });

  it("can apply the additive migration twice without changing an existing value", async () => {
    await isolated.query(await readFile(join(migrationsDir, "015_visitor_memory.sql"), "utf8"));
    expect((await isolated.query("SELECT count(*)::int AS count FROM schema_migrations WHERE version='015_visitor_memory.sql'")).rows[0]).toEqual({ count: 1 });
    expect((await isolated.query("SELECT count(*)::int AS count FROM visitor_memory_preferences")).rows[0]).toEqual({ count: 2 });
  });
});
