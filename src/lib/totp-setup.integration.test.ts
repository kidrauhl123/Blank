import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCustomer, SESSION_COOKIE, verifyCustomerTotp } from "./auth";
import { db, query } from "./db";
import { POST as prepare } from "../app/api/v1/security/totp/setup/route";
import { POST as confirm } from "../app/api/v1/security/totp/confirm/route";

function code(secret: string, offset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(value => parseInt(value, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const digest = createHmac("sha1", key).update(counter).digest(), index = digest[19] & 15;
  return ((digest.readUInt32BE(index) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("first-time verifier enrollment", () => {
  let demo: Awaited<ReturnType<typeof registerCustomer>>;
  let normal: Awaited<ReturnType<typeof registerCustomer>>;
  const password = "Test-only-123456";
  const request = (token: string, body: unknown, extra?: HeadersInit) => new Request("http://bank.test/api/v1/security/totp/setup", {
    method: "POST", headers: { host: "bank.test", origin: "http://bank.test", cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body),
  });
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    demo = await registerCustomer({ displayName: "Enrollment demo", phone: randomUUID(), password });
    normal = await registerCustomer({ displayName: "Enrollment normal", phone: randomUUID(), password });
    await query("INSERT INTO demo_profiles(profile_key,customer_id) VALUES('potato',$1)", [demo.customer.id]);
  });
  afterAll(async () => {
    for (const identity of [demo, normal]) if (identity) {
      await query("DELETE FROM demo_profiles WHERE customer_id=$1", [identity.customer.id]);
      await query("DELETE FROM audit_events WHERE customer_id=$1", [identity.customer.id]);
      await query("DELETE FROM accounts WHERE customer_id=$1", [identity.customer.id]);
      await query("DELETE FROM customers WHERE id=$1", [identity.customer.id]);
    }
    await db.end();
  });
  it("rejects foreign or missing origins and authorization headers before enrollment", async () => {
    expect((await prepare(request(demo.token, { demoConfirmed: true }, { origin: "http://foreign.test" }))).status).toBe(403);
    const missing = request(demo.token, { demoConfirmed: true }); missing.headers.delete("origin");
    expect((await prepare(missing)).status).toBe(403);
    expect((await prepare(request(demo.token, { demoConfirmed: true }, { authorization: "Bearer arbitrary" }))).status).toBe(403);
    expect((await query("SELECT 1 FROM mfa_totp WHERE customer_id=$1", [demo.customer.id])).rowCount).toBe(0);
  });
  it("requires explicit demo confirmation and refuses a client-supplied demo flag for ordinary accounts", async () => {
    expect((await prepare(request(demo.token, {}))).status).toBe(400);
    expect((await prepare(request(normal.token, { demoConfirmed: true }))).status).toBe(401);
    expect((await prepare(request(normal.token, { password: "wrong" }))).status).toBe(401);
    expect((await prepare(request(normal.token, { password }))).status).toBe(200);
  });
  it("requires a real dynamic code and cannot replace an enabled secret, including concurrent requests", async () => {
    const setup = await prepare(request(demo.token, { demoConfirmed: true }));
    expect(setup.status).toBe(200);
    const secret = (await setup.json()).secret;
    const invalid = await confirm(request(demo.token, { code: "invalid" }));
    expect(invalid.ok).toBe(false);
    const validWindow = new Set([-2, -1, 0, 1, 2].map(offset => code(secret, offset)));
    let incorrect = 0;
    while (validWindow.has(incorrect.toString().padStart(6, "0"))) incorrect++;
    expect((await confirm(request(demo.token, { code: incorrect.toString().padStart(6, "0") }))).status).toBe(401);
    expect(await verifyCustomerTotp(demo.customer.id, code(secret))).toBe(false);
    expect((await confirm(request(demo.token, { code: code(secret) }))).status).toBe(200);
    const before = (await query("SELECT encrypted_secret,enabled_at FROM mfa_totp WHERE customer_id=$1", [demo.customer.id])).rows[0];
    const attempts = await Promise.all(Array.from({ length: 3 }, () => prepare(request(demo.token, { demoConfirmed: true }))));
    expect(attempts.map(result => result.status)).toEqual([409, 409, 409]);
    expect((await query("SELECT encrypted_secret,enabled_at FROM mfa_totp WHERE customer_id=$1", [demo.customer.id])).rows[0]).toEqual(before);
    expect(await verifyCustomerTotp(demo.customer.id, code(secret))).toBe(true);
  });
});
