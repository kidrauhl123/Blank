import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { AuthError, getCookieValue } from "./auth";
import { requireAppSession } from "./app-session";
import { query } from "./db";

export const VISITOR_MEMORY_COOKIE = "bankpilot_memory_visitor";
const MEMORY_COOKIE_DAYS = 90;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function visitorMemoryCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: MEMORY_COOKIE_DAYS * 24 * 60 * 60,
    priority: "high" as const,
  };
}

// Called only after a successful demo login, inside that login's transaction.
// Unknown browser-supplied values are discarded rather than enrolled as owners.
export async function ensureVisitorMemoryToken(rawToken: string | undefined, client: PoolClient) {
  // Demo traffic provides a small, automatic cleanup opportunity. Reads also
  // filter expired rows, so cleanup timing cannot make stale values usable.
  await client.query("DELETE FROM visitor_memory_preferences WHERE expires_at<=now()");
  await client.query("DELETE FROM visitor_memory_owners WHERE expires_at<=now()");
  if (rawToken && TOKEN_PATTERN.test(rawToken)) {
    const existing = await client.query<{ id: string }>(
      "UPDATE visitor_memory_owners SET last_seen_at=now(),expires_at=now()+interval '90 days' WHERE token_hash=$1 AND expires_at>now() RETURNING id",
      [tokenHash(rawToken)],
    );
    if (existing.rowCount) return rawToken;
  }
  const token = randomBytes(32).toString("base64url");
  await client.query("INSERT INTO visitor_memory_owners(token_hash) VALUES($1)", [tokenHash(token)]);
  return token;
}

export type VisitorMemoryScope = { ownerId: string; profileKey: string };

// Missing or unknown visitor cookies produce no memory for ordinary assistant
// requests. The preference management API uses the strict variant below.
export async function resolveVisitorMemoryScope(request: Request, customerId: string): Promise<VisitorMemoryScope | null> {
  const token = getCookieValue(request, VISITOR_MEMORY_COOKIE);
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const result = await query<{ owner_id: string; profile_key: string }>(
    `SELECT v.id AS owner_id, d.profile_key
     FROM visitor_memory_owners v
     CROSS JOIN demo_profiles d
     WHERE v.token_hash=$1 AND v.expires_at>now() AND d.customer_id=$2`,
    [tokenHash(token), customerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ownerId: row.owner_id, profileKey: row.profile_key };
}

// Both identifiers come from authenticated server state; callers cannot choose
// an owner ID or a profile key through a request body or query parameter.
export async function requireVisitorMemoryScope(request: Request): Promise<VisitorMemoryScope> {
  const session = await requireAppSession(request);
  const scope = await resolveVisitorMemoryScope(request, session.customerId);
  if (!scope) throw new AuthError("MEMORY_VISITOR_REQUIRED", 403);
  return scope;
}
