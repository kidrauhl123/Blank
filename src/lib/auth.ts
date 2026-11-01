import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { matchingTotpStep } from "./totp";
import { deviceKeyOf } from "./device-key";

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = "bankpilot_session";
const SESSION_DAYS = 7;

export type AuthPrincipal = {
  customerId: string;
  kind: "SESSION";
  // 这个会话是新设备登录，并且还在登录后的 24 小时内（反诈守护用）。
  newDevice?: boolean;
};

export class AuthError extends Error {
  constructor(public code: string, public status = 401) {
    super(code);
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(input: Buffer) {
  let bits = 0; let value = 0; let output = "";
  for (const byte of input) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function mfaKey() {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper) throw new AuthError("SECURITY_CONFIGURATION_REQUIRED", 503);
  return createHash("sha256").update(`bankpilot:mfa:${pepper}`).digest();
}

function encryptSecret(secret: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", mfaKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptSecret(value: string) {
  const [iv, tag, ciphertext] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", mfaKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function parseCookies(header: string | null) {
  const result = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName && rest.length) {
      try { result.set(rawName, decodeURIComponent(rest.join("="))); }
      catch { /* Ignore malformed cookie values. */ }
    }
  }
  return result;
}

export function getCookieValue(request: Request, name: string) {
  return parseCookies(request.headers.get("cookie")).get(name);
}

export function getSessionToken(request: Request) {
  return getCookieValue(request, SESSION_COOKIE);
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires,
    priority: "high" as const,
  };
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const pepper = process.env.PASSWORD_PEPPER ?? "";
  const derived = await scrypt(`${password}${pepper}`, salt, 64) as Buffer;
  return { salt, hash: derived.toString("hex") };
}

export async function verifyPassword(password: string, salt: string, expectedHex: string) {
  const actual = Buffer.from((await hashPassword(password, salt)).hash, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function accountNumber() {
  return `622202${String(randomInt(0, 10_000_000_000)).padStart(10, "0")}`;
}

export async function registerCustomer(input: { displayName: string; phone: string; password: string; userAgent?: string | null }) {
  const password = await hashPassword(input.password);
  return withTransaction(async (client) => {
    try {
      const customer = await client.query<{ id: string; display_name: string; phone: string }>(
        `INSERT INTO customers (display_name,phone,risk_profile)
         VALUES ($1,$2,'UNASSESSED') RETURNING id,display_name,phone`,
        [input.displayName, input.phone],
      );
      const row = customer.rows[0];
      await client.query(
        `INSERT INTO auth_credentials (customer_id,password_salt,password_hash) VALUES ($1,$2,$3)`,
        [row.id, password.salt, password.hash],
      );
      const number = accountNumber();
      await client.query(
        `INSERT INTO accounts (customer_id,name,account_type,account_no,masked_no,currency,available_balance_minor,status)
         VALUES ($1,'活期账户','CHECKING',$2,$3,'CNY',0,'ACTIVE')`,
        [row.id, number, `•• ${number.slice(-4)}`],
      );
      await client.query(
        `INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence)
         VALUES ($1,'CUSTOMER_REGISTERED','USER','客户完成注册并开立零余额活期账户',$2::jsonb)`,
        [row.id, JSON.stringify({ accountOpening: "USER_INITIATED", initialBalanceMinor: 0 })],
      );
      const session = await createSession(row.id, input.userAgent, client);
      return { customer: row, ...session };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AuthError("PHONE_ALREADY_REGISTERED", 409);
      throw error;
    }
  });
}

export async function createSession(customerId: string, userAgent?: string | null, client?: PoolClient) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const run = client ? client.query.bind(client) : query;
  // 设备记录和“是否新设备”在同一条语句里判断：客户之前已经有别的设备，这次是第一次从这台设备登录，就是新设备。
  // 演示账户由访客共用、会在不同浏览器里反复登录，不适用这个规则。
  const deviceKey = deviceKeyOf(userAgent);
  const device = await run<{ created: boolean; known: number; demo: boolean }>(
    `WITH before AS (SELECT count(*)::int AS n FROM customer_devices WHERE customer_id=$1),
     upsert AS (INSERT INTO customer_devices (customer_id,device_key) VALUES ($1,$2)
       ON CONFLICT (customer_id,device_key) DO UPDATE SET last_seen_at=now()
       RETURNING (xmax = 0) AS created)
     SELECT (SELECT created FROM upsert) AS created, (SELECT n FROM before) AS known,
            EXISTS (SELECT 1 FROM demo_profiles WHERE customer_id=$1) AS demo`,
    [customerId, deviceKey]);
  const { created, known, demo } = device.rows[0];
  const newDevice = Boolean(created && known >= 1 && !demo);
  await run(`INSERT INTO user_sessions (customer_id,token_hash,user_agent,expires_at,device_key,new_device) VALUES ($1,$2,$3,$4,$5,$6)`,
    [customerId, sha256(token), userAgent?.slice(0, 300) ?? null, expires, deviceKey, newDevice]);
  return { token, expires };
}

export async function loginCustomer(input: { phone: string; password: string; userAgent?: string | null }) {
  const credential = await query<{
    customer_id: string; display_name: string; phone: string; status: string;
    password_salt: string; password_hash: string; failed_attempts: number; locked_until: Date | null;
  }>(
    `SELECT c.id AS customer_id,c.display_name,c.phone,c.status,
            a.password_salt,a.password_hash,a.failed_attempts,a.locked_until
     FROM customers c JOIN auth_credentials a ON a.customer_id=c.id WHERE c.phone=$1`,
    [input.phone],
  );
  const row = credential.rows[0];
  if (!row) throw new AuthError("INVALID_CREDENTIALS");
  if (row.status !== "ACTIVE") throw new AuthError("CUSTOMER_UNAVAILABLE", 403);
  if (row.locked_until && row.locked_until > new Date()) throw new AuthError("LOGIN_TEMPORARILY_LOCKED", 423);
  if (!(await verifyPassword(input.password, row.password_salt, row.password_hash))) {
    await query(
      `UPDATE auth_credentials SET failed_attempts=failed_attempts+1,
       locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END
       WHERE customer_id=$1`,
      [row.customer_id],
    );
    throw new AuthError("INVALID_CREDENTIALS");
  }
  await query("UPDATE auth_credentials SET failed_attempts=0,locked_until=NULL WHERE customer_id=$1", [row.customer_id]);
  const session = await createSession(row.customer_id, input.userAgent);
  await query(
    `INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence)
     VALUES ($1,'SESSION_AUTHENTICATED','SYSTEM','客户通过密码验证登录','{}'::jsonb)`,
    [row.customer_id],
  );
  return { customer: { id: row.customer_id, display_name: row.display_name, phone: row.phone }, ...session };
}

export async function logoutSession(rawToken: string | undefined) {
  if (!rawToken) return;
  await query("UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [sha256(rawToken)]);
}

export async function authenticateRequest(request: Request): Promise<AuthPrincipal> {
  // APP identity comes only from its bank session. Do not fall back to cookies
  // when a retired client token or an internal adapter credential is supplied.
  if (request.headers.has("authorization")) throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);

  const raw = getSessionToken(request);
  if (!raw) throw new AuthError("AUTHENTICATION_REQUIRED");
  const result = await query<{ customer_id: string; new_device: boolean }>(
    `UPDATE user_sessions s SET last_seen_at=now()
     FROM customers c
     WHERE s.token_hash=$1 AND s.customer_id=c.id AND s.revoked_at IS NULL
       AND s.expires_at>now() AND c.status='ACTIVE'
     RETURNING s.customer_id, (s.new_device AND s.created_at > now() - interval '24 hours') AS new_device`,
    [sha256(raw)],
  );
  if (!result.rows[0]) throw new AuthError("SESSION_EXPIRED");
  return { customerId: result.rows[0].customer_id, kind: "SESSION", newDevice: result.rows[0].new_device };
}

export async function verifyCustomerPassword(customerId: string, password: string) {
  const result = await query<{ password_salt: string; password_hash: string }>(
    "SELECT password_salt,password_hash FROM auth_credentials WHERE customer_id=$1",
    [customerId],
  );
  const row = result.rows[0];
  return Boolean(row && await verifyPassword(password, row.password_salt, row.password_hash));
}

export async function beginTotpSetup(customerId: string) {
  const secret = base32Encode(randomBytes(20));
  const identity = await query<{ display_name: string; phone: string }>("SELECT display_name,phone FROM customers WHERE id=$1", [customerId]);
  if (!identity.rows[0]) throw new AuthError("CUSTOMER_UNAVAILABLE", 403);
  await withTransaction(async (client) => {
    await client.query("SELECT id FROM customers WHERE id=$1 FOR NO KEY UPDATE", [customerId]);
    if (await mfaLocked(customerId, client)) throw new AuthError("AUTH_FUSE_ACTIVE", 423);
    const setup = await client.query(
      `INSERT INTO mfa_totp (customer_id,encrypted_secret,enabled_at) VALUES ($1,$2,NULL)
       ON CONFLICT (customer_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,updated_at=now()
       WHERE mfa_totp.enabled_at IS NULL RETURNING customer_id`,
      [customerId, encryptSecret(secret)],
    );
    if (!setup.rows.length) throw new AuthError("MFA_ALREADY_CONFIGURED", 409);
  });
  const label = encodeURIComponent(`Blank:${identity.rows[0].phone}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=Blank&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

export async function confirmTotpSetup(customerId: string, code: string) {
  const outcome = await withTransaction(async (client) => {
    const result = await consumeTotp(customerId, code, client, true);
    if (result !== "VERIFIED") return result;
    await client.query("UPDATE mfa_totp SET enabled_at=now(),updated_at=now() WHERE customer_id=$1", [customerId]);
    await client.query(`INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence) VALUES ($1,'MFA_ENABLED','USER','客户启用 TOTP 多因素认证','{}'::jsonb)`, [customerId]);
    return result;
  });
  // Throw only after committing failed-attempt accounting.
  if (outcome !== "VERIFIED") throw new AuthError(outcome === "LOCKED" ? "AUTH_FUSE_ACTIVE" : "MFA_INVALID", outcome === "LOCKED" ? 423 : 401);
  return { enabled: true };
}

async function mfaLocked(customerId: string, client: PoolClient) {
  const result = await client.query<{ locked: boolean }>(
    "SELECT locked_until>clock_timestamp() AS locked FROM mfa_auth_state WHERE customer_id=$1", [customerId],
  );
  return result.rows[0]?.locked === true;
}

export type TotpOutcome = "VERIFIED" | "INVALID" | "REPLAYED" | "LOCKED";

async function consumeTotp(customerId: string, code: string, client: PoolClient, enrollment = false): Promise<TotpOutcome> {
  // All MFA paths use the same customer lock as transfer execution. Enrollment,
  // other accounts and official channels cannot race/reset the failure budget.
  await client.query("SELECT id FROM customers WHERE id=$1 FOR NO KEY UPDATE", [customerId]);
  if (await mfaLocked(customerId, client)) return "LOCKED";
  const result = await client.query<{ encrypted_secret: string; last_used_step: string | null; at: Date }>(
    `SELECT encrypted_secret,last_used_step,clock_timestamp() AS at FROM mfa_totp
     WHERE customer_id=$1 AND ${enrollment ? "enabled_at IS NULL" : "enabled_at IS NOT NULL"} FOR UPDATE`, [customerId],
  );
  const row = result.rows[0];
  const step = row ? matchingTotpStep(decryptSecret(row.encrypted_secret), code, row.at) : null;
  const replayed = step !== null && row.last_used_step !== null && step <= Number(row.last_used_step);
  if (step !== null && !replayed) {
    await client.query("UPDATE mfa_totp SET last_used_step=$2,updated_at=now() WHERE customer_id=$1", [customerId, step]);
    await client.query("DELETE FROM mfa_auth_state WHERE customer_id=$1", [customerId]);
    return "VERIFIED";
  }
  const failure = await client.query<{ failed_attempts: number }>(
    `INSERT INTO mfa_auth_state(customer_id,failed_attempts) VALUES($1,1)
     ON CONFLICT(customer_id) DO UPDATE SET
       failed_attempts=CASE WHEN mfa_auth_state.locked_until IS NOT NULL THEN 1 ELSE mfa_auth_state.failed_attempts+1 END,
       locked_until=NULL,updated_at=now() RETURNING failed_attempts`, [customerId],
  );
  const locked = failure.rows[0].failed_attempts >= 3;
  if (locked) await client.query("UPDATE mfa_auth_state SET locked_until=clock_timestamp()+interval '15 minutes' WHERE customer_id=$1", [customerId]);
  await client.query(`INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary,evidence)
    VALUES($1,'MFA_ATTEMPT_REJECTED','RISK_ENGINE','多因素认证失败，已计入客户级失败次数',$2::jsonb)`,
  [customerId, JSON.stringify({ reason: replayed ? "REPLAYED" : "INVALID", enrollment, attempts: failure.rows[0].failed_attempts, locked })]);
  return locked ? "LOCKED" : replayed ? "REPLAYED" : "INVALID";
}

export async function consumeCustomerTotp(customerId: string, code: string, client: PoolClient) {
  return consumeTotp(customerId, code, client);
}

export async function verifyCustomerTotp(customerId: string, code: string, client?: PoolClient) {
  const outcome = client ? await consumeTotp(customerId, code, client)
    : await withTransaction(transaction => consumeTotp(customerId, code, transaction));
  return outcome === "VERIFIED";
}

// Superseded by consumeTotp above: the PR #2 CAS-only variant (fourth arg `at`,
// boolean result, no cooldown) is retired. Its migration 018 column stays for
// already-deployed databases, but the customer-level cooldown path is authoritative.

