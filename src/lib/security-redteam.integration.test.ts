import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTotpSetup, confirmTotpSetup, registerCustomer } from "./auth";
import { commitTransfer, prepareTransfer, recordDeposit } from "./bank-core";
import { db, query } from "./db";

// Synthetic identities only. Never point this suite at a deployed database.
function code(secret: string, stepOffset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(c => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(v => parseInt(v, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + stepOffset));
  const digest = createHmac("sha1", key).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

describe.skipIf(process.env.BANKPILOT_SECURITY_TESTS !== "1")("security red-team regression", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test" || url.pathname !== "/bankpilot_security_test") {
      throw new Error("Use only the isolated local bankpilot_security_test database");
    }
    if (!process.env.PASSWORD_PEPPER) throw new Error("Test-only pepper required");
  });
  afterAll(async () => { await db.end(); });
  const customer = async () => {
    const name = `Security-${randomUUID()}`;
    const identity = await registerCustomer({ displayName: name, phone: randomUUID(), password: "Fixture-only-123456" });
    const account = (await query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=$1", [identity.customer.id])).rows[0].id;
    return { id: identity.customer.id, name, account };
  };
  const fixture = async () => {
    const payer = await customer(), recipient = await customer();
    await recordDeposit(payer.id, { accountId: payer.account, amountMinor: 500000, source: "CASH" });
    const prepare = (amountMinor = 10000) => prepareTransfer(payer.id, { fromAccountId: payer.account, recipient: recipient.name, amountMinor });
    return { payer, recipient, prepare };
  };
  const postingCount = async (operationId: string) => Number((await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM ledger_transactions l JOIN transfers t ON t.id=l.transfer_id WHERE t.operation_id=$1", [operationId],
  )).rows[0].count);

  it("RT-01 rejects a yellow draft older than ten minutes with no ledger posting", async () => {
    const { payer, prepare } = await fixture(); const draft = await prepare();
    await query("UPDATE transfers SET prepared_at=now()-interval '11 minutes' WHERE operation_id=$1", [draft.operationId]);
    await expect(commitTransfer(payer.id, draft.operationId, {})).rejects.toThrow("AUTH_EXPIRED");
    expect(await postingCount(draft.operationId)).toBe(0);
  });
  it("RT-02 rejects a draft whose stored amount was changed after preparation", async () => {
    const { payer, prepare } = await fixture(); const draft = await prepare();
    await query("UPDATE transfers SET amount_minor=amount_minor+1 WHERE operation_id=$1", [draft.operationId]);
    await expect(commitTransfer(payer.id, draft.operationId, {})).rejects.toThrow("AUTHORIZATION_MISMATCH");
    expect(await postingCount(draft.operationId)).toBe(0);
  });
  it("RT-03 rejects beneficiary destination substitution after preparation", async () => {
    const { payer, prepare } = await fixture(); const alternate = await customer(); const draft = await prepare();
    await query(`UPDATE beneficiaries SET settlement_account_id=$2,recipient_customer_id=$3
      WHERE id=(SELECT beneficiary_id FROM transfers WHERE operation_id=$1)`, [draft.operationId, alternate.account, alternate.id]);
    await expect(commitTransfer(payer.id, draft.operationId, {})).rejects.toThrow("AUTHORIZATION_MISMATCH");
    expect(await postingCount(draft.operationId)).toBe(0);
  });
  it("RT-04 refuses the same TOTP on a second high-risk transaction", async () => {
    const { payer, prepare } = await fixture();
    const { secret } = await beginTotpSetup(payer.id); await confirmTotpSetup(payer.id, code(secret));
    const first = await prepare(110000), second = await prepare(110000); const otp = code(secret, 1);
    expect(await commitTransfer(payer.id, first.operationId, { totpCode: otp })).toMatchObject({ status: "SUCCEEDED" });
    expect(await commitTransfer(payer.id, second.operationId, { totpCode: otp })).toMatchObject({ authError: "AUTH_INVALID" });
    expect(await postingCount(second.operationId)).toBe(0);
  });
  it("RT-05 permits at most one posting when two drafts race with the same TOTP", async () => {
    const { payer, prepare } = await fixture();
    const { secret } = await beginTotpSetup(payer.id); await confirmTotpSetup(payer.id, code(secret));
    const drafts = await Promise.all([prepare(110000), prepare(110000)]); const otp = code(secret, 1);
    const results = await Promise.all(drafts.map(d => commitTransfer(payer.id, d.operationId, { totpCode: otp })));
    expect(results.filter(r => "status" in r && r.status === "SUCCEEDED")).toHaveLength(1);
    expect(results.filter(r => "authError" in r && r.authError === "AUTH_INVALID")).toHaveLength(1);
  });
  it("RT-06 keeps customer isolation at the core transaction boundary", async () => {
    const { recipient, prepare } = await fixture(); const draft = await prepare();
    await expect(commitTransfer(recipient.id, draft.operationId, {})).rejects.toThrow("OPERATION_NOT_FOUND");
    expect(await postingCount(draft.operationId)).toBe(0);
  });
  it("RT-07 returns the original receipt on retry without double posting", async () => {
    const { payer, prepare } = await fixture(); const draft = await prepare();
    const first = await commitTransfer(payer.id, draft.operationId, {});
    const second = await commitTransfer(payer.id, draft.operationId, {});
    expect(first).toMatchObject({ status: "SUCCEEDED" });
    expect(second).toMatchObject({ status: "SUCCEEDED", alreadyExecuted: true });
    expect(await postingCount(draft.operationId)).toBe(1);
  });
  it("RT-08 rolls back TOTP consumption when the ledger transaction fails", async () => {
    const { payer, prepare } = await fixture();
    const { secret } = await beginTotpSetup(payer.id); await confirmTotpSetup(payer.id, code(secret));
    const draft = await prepare(110000); const otp = code(secret, 1);
    // Enrollment consumed its own step; capture that baseline so the
    // assertion below tests exactly the failed transfer's consumption.
    const baseline = (await query<{ step: string | null }>("SELECT last_used_step::text AS step FROM mfa_totp WHERE customer_id=$1", [payer.id])).rows[0].step;
    const blocker = (await query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type) VALUES($1,'TEST') RETURNING id", [`LED-${draft.operationId}`])).rows[0].id;
    try {
      await expect(commitTransfer(payer.id, draft.operationId, { totpCode: otp })).rejects.toMatchObject({ code: "23505" });
      expect((await query<{ step: string | null }>("SELECT last_used_step::text AS step FROM mfa_totp WHERE customer_id=$1", [payer.id])).rows[0].step).toBe(baseline);
      expect(await postingCount(draft.operationId)).toBe(0);
    } finally { await query("DELETE FROM ledger_transactions WHERE id=$1", [blocker]); }
    expect(await commitTransfer(payer.id, draft.operationId, { totpCode: otp })).toMatchObject({ status: "SUCCEEDED" });
  });
  it("RT-09 locks a challenge after three rejected codes without posting", async () => {
    const { payer, prepare } = await fixture(); const draft = await prepare(110000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await commitTransfer(payer.id, draft.operationId, { totpCode: "000000" })).toMatchObject({ authError: attempt === 3 ? "AUTH_FUSE_ACTIVE" : "AUTH_INVALID" });
    }
    await expect(commitTransfer(payer.id, draft.operationId, { totpCode: "000000" })).rejects.toThrow("AUTH_FUSE_ACTIVE");
    expect(await postingCount(draft.operationId)).toBe(0);
  });
});
