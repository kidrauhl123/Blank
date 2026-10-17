import type { PoolClient } from "pg";
import { AuthError } from "./auth";
import { query, withTransaction } from "./db";
import type { VisitorMemoryScope } from "./visitor-memory";

export const PREFERENCE_KEYS = ["preferred_name", "response_language", "response_detail"] as const;
export type PreferenceKey = typeof PREFERENCE_KEYS[number];
export type PreferenceSource = "USER_EXPLICIT" | "USER_SETTINGS";
export type SavedPreference = { value: string; source: PreferenceSource; version: string; updatedAt: string; expiresAt: string };
export type PreferenceState = {
  enabled: boolean;
  version: string;
  preferences: Partial<Record<PreferenceKey, SavedPreference>>;
  retainedCount: number;
};

type PreferenceRow = {
  enabled: boolean;
  scope_version: string;
  preference_key: PreferenceKey | null;
  preference_value: string | null;
  source_kind: PreferenceSource | null;
  preference_version: string | null;
  updated_at: Date | null;
  expires_at: Date | null;
};

const VERSION_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const MAX_VERSION = BigInt("9223372036854775807");
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .·'’-]*$/u;
const FORBIDDEN_NAME_TERMS = /验证码|密码|密钥|银行卡|卡号|账号|余额|转账|确认|授权|跳过|忽略|规则|指令|系统|prompt|token|api.?key|secret|sk-[A-Za-z0-9]{8,}|ignore|instruction|assistant|developer|system|override|password|otp/iu;

function validateVersion(version: string) {
  if (!VERSION_PATTERN.test(version) || BigInt(version) > MAX_VERSION) throw new AuthError("PREFERENCE_INVALID", 400);
  return version;
}

export function normalizePreferenceValue(key: PreferenceKey, rawValue: string): string {
  if (key === "response_language") {
    if (rawValue !== "zh-CN" && rawValue !== "en") throw new AuthError("PREFERENCE_INVALID", 400);
    return rawValue;
  }
  if (key === "response_detail") {
    if (rawValue !== "brief" && rawValue !== "standard" && rawValue !== "detailed") throw new AuthError("PREFERENCE_INVALID", 400);
    return rawValue;
  }
  if (key !== "preferred_name") throw new AuthError("PREFERENCE_INVALID", 400);
  if (/[\p{Cc}\p{Cf}]/u.test(rawValue)) throw new AuthError("PREFERENCE_INVALID", 400);
  const name = rawValue.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (Array.from(name).length < 1 || Array.from(name).length > 40 ||
      !NAME_PATTERN.test(name) || (name.match(/\p{N}/gu)?.length ?? 0) > 3 ||
      FORBIDDEN_NAME_TERMS.test(name)) throw new AuthError("PREFERENCE_INVALID", 400);
  return name;
}

async function loadState(scope: VisitorMemoryScope, client?: PoolClient): Promise<PreferenceState> {
  const sql = `SELECT s.enabled,s.version::text AS scope_version,
       p.preference_key,p.preference_value,p.source_kind,p.version::text AS preference_version,p.updated_at,p.expires_at
     FROM visitor_memory_scopes s
     LEFT JOIN visitor_memory_preferences p ON p.owner_id=s.owner_id AND p.profile_key=s.profile_key AND p.expires_at>now()
     WHERE s.owner_id=$1 AND s.profile_key=$2`;
  const values = [scope.ownerId, scope.profileKey];
  const result = client ? await client.query<PreferenceRow>(sql, values) : await query<PreferenceRow>(sql, values);
  const first = result.rows[0];
  if (!first) return { enabled: true, version: "0", preferences: {}, retainedCount: 0 };
  const preferences: PreferenceState["preferences"] = {};
  let retainedCount = 0;
  for (const row of result.rows) {
    if (!row.preference_key || !row.preference_value || !row.source_kind || !row.preference_version || !row.updated_at || !row.expires_at) continue;
    retainedCount += 1;
    if (first.enabled) preferences[row.preference_key] = {
      value: row.preference_value,
      source: row.source_kind,
      version: row.preference_version,
      updatedAt: row.updated_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  }
  return { enabled: first.enabled, version: first.scope_version, preferences, retainedCount };
}

export async function getPreferenceState(scope: VisitorMemoryScope) {
  return loadState(scope);
}

// Model-facing callers use this view, which never returns values while disabled.
export async function getActivePreferenceValues(scope: VisitorMemoryScope): Promise<Partial<Record<PreferenceKey, string>>> {
  const state = await loadState(scope);
  return Object.fromEntries(Object.entries(state.preferences).map(([key, preference]) => [key, preference.value]));
}

async function mutate(
  scope: VisitorMemoryScope,
  expectedVersion: string,
  change: (client: PoolClient, enabled: boolean) => Promise<number | void>,
) {
  validateVersion(expectedVersion);
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO visitor_memory_scopes(owner_id,profile_key) VALUES($1,$2)
       ON CONFLICT (owner_id,profile_key) DO NOTHING`,
      [scope.ownerId, scope.profileKey],
    );
    const locked = await client.query<{ enabled: boolean; version: string }>(
      `SELECT enabled,version::text AS version FROM visitor_memory_scopes
       WHERE owner_id=$1 AND profile_key=$2 FOR UPDATE`,
      [scope.ownerId, scope.profileKey],
    );
    const current = locked.rows[0];
    if (!current || current.version !== expectedVersion) throw new AuthError("PREFERENCE_VERSION_CONFLICT", 409);
    const changedCount = await change(client, current.enabled);
    await client.query(
      `UPDATE visitor_memory_scopes SET version=version+1,updated_at=now()
       WHERE owner_id=$1 AND profile_key=$2`,
      [scope.ownerId, scope.profileKey],
    );
    return { state: await loadState(scope, client), changedCount: changedCount ?? 0 };
  });
}

export async function savePreference(
  scope: VisitorMemoryScope,
  key: PreferenceKey,
  rawValue: string,
  expectedVersion: string,
  source: PreferenceSource = "USER_SETTINGS",
) {
  const value = normalizePreferenceValue(key, rawValue);
  if (source !== "USER_EXPLICIT" && source !== "USER_SETTINGS") throw new AuthError("PREFERENCE_INVALID", 400);
  return mutate(scope, expectedVersion, async (client, enabled) => {
    if (!enabled) throw new AuthError("PREFERENCE_MEMORY_DISABLED", 409);
    await client.query(
      `INSERT INTO visitor_memory_preferences
         (owner_id,profile_key,preference_key,preference_value,source_kind,updated_at,expires_at)
       VALUES($1,$2,$3,$4,$5,now(),now()+interval '90 days')
       ON CONFLICT (owner_id,profile_key,preference_key) DO UPDATE SET
         preference_value=excluded.preference_value,source_kind=excluded.source_kind,
         version=visitor_memory_preferences.version+1,updated_at=now(),expires_at=now()+interval '90 days'`,
      [scope.ownerId, scope.profileKey, key, value, source],
    );
    await client.query(
      "UPDATE visitor_memory_owners SET last_seen_at=now(),expires_at=now()+interval '90 days' WHERE id=$1",
      [scope.ownerId],
    );
  });
}

export async function deletePreference(scope: VisitorMemoryScope, key: PreferenceKey, expectedVersion: string) {
  return mutate(scope, expectedVersion, async (client) => {
    const result = await client.query(
      `DELETE FROM visitor_memory_preferences
       WHERE owner_id=$1 AND profile_key=$2 AND preference_key=$3`,
      [scope.ownerId, scope.profileKey, key],
    );
    return result.rowCount ?? 0;
  });
}

export async function clearPreferences(scope: VisitorMemoryScope, expectedVersion: string) {
  return mutate(scope, expectedVersion, async (client) => {
    const result = await client.query(
      "DELETE FROM visitor_memory_preferences WHERE owner_id=$1 AND profile_key=$2",
      [scope.ownerId, scope.profileKey],
    );
    return result.rowCount ?? 0;
  });
}

export async function setPreferenceMemoryEnabled(scope: VisitorMemoryScope, enabled: boolean, expectedVersion: string) {
  return mutate(scope, expectedVersion, async (client) => {
    await client.query(
      "UPDATE visitor_memory_scopes SET enabled=$3 WHERE owner_id=$1 AND profile_key=$2",
      [scope.ownerId, scope.profileKey, enabled],
    );
  });
}
