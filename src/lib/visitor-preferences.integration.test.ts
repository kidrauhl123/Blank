import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock("./db", () => database);

import { ensureVisitorMemoryToken } from "./visitor-memory";
import { clearPreferences, deletePreference, getActivePreferenceValues, getPreferenceState, savePreference, setPreferenceMemoryEnabled } from "./visitor-preferences";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("visitor preference lifecycle", () => {
  const databaseName = `bankpilot_preference_${randomUUID().replaceAll("-", "")}`;
  const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  const customerA = randomUUID();
  const customerB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const tokenA = Buffer.alloc(32, 7).toString("base64url");
  const scopeA = { ownerId: ownerA, profileKey: "memory-a" };
  const scopeB = { ownerId: ownerB, profileKey: "memory-a" };
  const otherProfile = { ownerId: ownerA, profileKey: "memory-b" };
  let maintenance: Pool;
  let isolated: Pool;
  let createdDatabase = false;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test maintenance connection with CREATEDB");
    if (!/^bankpilot_preference_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unsafe fixture database name");
    maintenance = new Pool({ connectionString: url.toString(), max: 1 });
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    createdDatabase = true;
    url.pathname = `/${databaseName}`;
    isolated = new Pool({ connectionString: url.toString(), max: 2 });
    const versions = (await readdir(migrationsDir)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
    for (const version of versions) await isolated.query(await readFile(join(migrationsDir, version), "utf8"));
    await isolated.query("INSERT INTO customers(id,display_name,phone) VALUES($1,'A','pref-a'),($2,'B','pref-b')", [customerA, customerB]);
    await isolated.query("INSERT INTO demo_profiles(profile_key,customer_id) VALUES('memory-a',$1),('memory-b',$2)", [customerA, customerB]);
    await isolated.query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2),($3,$4)", [
      ownerA, createHash("sha256").update(tokenA).digest("hex"), ownerB, "b".repeat(64),
    ]);
    database.query.mockImplementation((sql: string, values: unknown[]) => isolated.query(sql, values));
    database.withTransaction.mockImplementation(async (work: (client: PoolClient) => Promise<unknown>) => {
      const client = await isolated.connect();
      try {
        await client.query("BEGIN");
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    });
  });

  beforeEach(async () => {
    await isolated.query("DELETE FROM visitor_memory_scopes");
  });

  afterAll(async () => {
    try {
      if (isolated) await isolated.end();
      if (createdDatabase) {
        if (!/^bankpilot_preference_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unsafe fixture database name");
        await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      }
    } finally { if (maintenance) await maintenance.end(); }
  });

  it("keeps different visitors and profiles isolated", async () => {
    expect(await getPreferenceState(scopeA)).toMatchObject({ enabled: true, version: "0", preferences: {} });
    const saved = await savePreference(scopeA, "preferred_name", "小陈", "0");
    expect(saved.state.preferences.preferred_name?.value).toBe("小陈");
    expect(saved.state.preferences.preferred_name?.source).toBe("USER_SETTINGS");
    expect((await getPreferenceState(scopeB)).preferences).toEqual({});
    expect((await getPreferenceState(otherProfile)).preferences).toEqual({});
  });

  it("rejects a stale update and preserves the newer explicit value", async () => {
    await savePreference(scopeA, "response_detail", "brief", "0");
    await expect(savePreference(scopeA, "response_detail", "detailed", "0")).rejects.toThrow("PREFERENCE_VERSION_CONFLICT");
    expect((await getPreferenceState(scopeA)).preferences.response_detail?.value).toBe("brief");
  });

  it("stops reading and saving when disabled, while allowing explicit clearing", async () => {
    await savePreference(scopeA, "response_language", "en", "0");
    const disabled = await setPreferenceMemoryEnabled(scopeA, false, "1");
    expect(disabled.state).toMatchObject({ enabled: false, version: "2", preferences: {}, retainedCount: 1 });
    expect(await getActivePreferenceValues(scopeA)).toEqual({});
    await expect(savePreference(scopeA, "response_language", "zh-CN", "2")).rejects.toThrow("PREFERENCE_MEMORY_DISABLED");
    const cleared = await clearPreferences(scopeA, "2");
    expect(cleared.changedCount).toBe(1);
    expect((await setPreferenceMemoryEnabled(scopeA, true, "3")).state.preferences).toEqual({});
  });

  it("deletes one key or all keys without touching another visitor", async () => {
    await savePreference(scopeA, "preferred_name", "小陈", "0");
    await savePreference(scopeA, "response_detail", "brief", "1");
    await savePreference(scopeB, "response_detail", "detailed", "0");
    expect((await deletePreference(scopeA, "preferred_name", "2")).changedCount).toBe(1);
    expect((await clearPreferences(scopeA, "3")).changedCount).toBe(1);
    expect((await getPreferenceState(scopeA)).preferences).toEqual({});
    expect((await getPreferenceState(scopeB)).preferences.response_detail?.value).toBe("detailed");
  });

  it("hides expired preferences and physically prunes them at the next login", async () => {
    await savePreference(scopeA, "preferred_name", "小陈", "0");
    await isolated.query("UPDATE visitor_memory_preferences SET updated_at=now()-interval '100 days',expires_at=now()-interval '1 day' WHERE owner_id=$1", [ownerA]);
    expect((await getPreferenceState(scopeA)).preferences).toEqual({});
    const client = await isolated.connect();
    try {
      await client.query("BEGIN");
      expect(await ensureVisitorMemoryToken(tokenA, client)).toBe(tokenA);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect((await isolated.query("SELECT 1 FROM visitor_memory_preferences WHERE owner_id=$1", [ownerA])).rowCount).toBe(0);
  });
});
