import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query, withTransaction } from "./db";
import {
  acceptLinkInvite, createLinkInvite, listBlankInbox, listBlankLinks, notifyFraudHoldToLinks, revokeBlankLink, sendBlankMessage,
} from "./blank-link-store";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("Blank 互联（真实数据库）", () => {
  const ids = { parent: randomUUID(), child: randomUUID(), friend: randomUUID(), second: randomUUID() };
  const accounts = { parent: randomUUID(), friend: randomUUID(), second: randomUUID() };
  const phones = { parent: `1380${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, child: `1391${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}` };
  const names = { parent: "妈妈互联", child: "孩子互联", friend: "小橘子互联", second: "二宝互联" };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9),($10,$11,$12)",
      [ids.parent, names.parent, phones.parent, ids.child, names.child, phones.child, ids.friend, names.friend, randomUUID(), ids.second, names.second, randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no,available_balance_minor) VALUES($1,$2,'测试','CHECKING','TEST',0),($3,$4,'测试','CHECKING','TEST',0),($5,$6,'测试','CHECKING','TEST',1200)",
      [accounts.parent, ids.parent, accounts.friend, ids.friend, accounts.second, ids.second]);
    // 妈妈的流水：11 月 1 日在漫拿咖啡花了 32 元，10 月 30 日在书店花了 45 元。
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES
      ($1,'漫拿咖啡','餐饮',-3200,'2026-11-01T02:00:00Z'),
      ($1,'书店','购物',-4500,'2026-10-30T02:00:00Z')`, [accounts.parent]);
    // 小橘子的流水：11 月 1 日在漫拿咖啡也有一笔，书店没有。
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'漫拿咖啡','餐饮',-2800,'2026-11-01T06:00:00Z')", [accounts.friend]);
  });
  afterAll(async () => {
    const all = Object.values(ids);
    await query("DELETE FROM blank_messages WHERE from_customer_id=ANY($1::uuid[]) OR to_customer_id=ANY($1::uuid[])", [all]);
    await query("DELETE FROM blank_links WHERE customer_a=ANY($1::uuid[]) OR customer_b=ANY($1::uuid[])", [all]);
    await query("DELETE FROM blank_link_invites WHERE from_customer_id=ANY($1::uuid[]) OR used_by_customer_id=ANY($1::uuid[])", [all]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [all]);
    await query("DELETE FROM bank_transactions WHERE account_id=ANY($1::uuid[])", [Object.values(accounts)]);
    await query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [Object.values(accounts)]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [all]);
    await db.end();
  });

  // 从邀请码到生效的互联：邀请方给出的范围，接受方只能选其中的一部分。
  async function connect(from: string, to: string, relation: "FAMILY" | "FRIEND", offered: Array<"FRAUD_ALERT" | "SAVINGS" | "SPLIT">, accepted: Array<"FRAUD_ALERT" | "SAVINGS" | "SPLIT">) {
    const invite = await createLinkInvite(from, { relation, scopes: offered });
    if (!invite.ok) throw new Error(invite.error);
    const accept = await acceptLinkInvite(to, { code: invite.code, scopes: accepted });
    if (!accept.ok) throw new Error(accept.error);
    return accept.linkId;
  }

  it("邀请只能给关系允许的内容；接受方只能选邀请里的一部分；邀请码只能用一次", async () => {
    expect(await createLinkInvite(ids.friend, { relation: "FRIEND", scopes: ["FRAUD_ALERT"] })).toMatchObject({ ok: false, code: "INVALID" });
    const invite = await createLinkInvite(ids.parent, { relation: "FAMILY", scopes: ["FRAUD_ALERT", "SPLIT"] });
    if (!invite.ok) throw new Error(invite.error);
    expect(await acceptLinkInvite(ids.child, { code: invite.code, scopes: ["SAVINGS"] })).toMatchObject({ ok: false, code: "INVALID" });
    const accepted = await acceptLinkInvite(ids.child, { code: invite.code, scopes: ["FRAUD_ALERT"] });
    expect(accepted).toMatchObject({ ok: true, relation: "FAMILY", scopes: ["FRAUD_ALERT"] });
    expect(await acceptLinkInvite(ids.child, { code: invite.code, scopes: ["FRAUD_ALERT"] })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await listBlankLinks(ids.parent)).links).toEqual([expect.objectContaining({ otherName: names.child, scopes: ["FRAUD_ALERT"] })]);
  });

  it("不能接受自己的邀请；同一对人只能有一条生效的互联", async () => {
    const own = await createLinkInvite(ids.parent, { relation: "FRIEND", scopes: ["SPLIT"] });
    if (!own.ok) throw new Error(own.error);
    expect(await acceptLinkInvite(ids.parent, { code: own.code, scopes: ["SPLIT"] })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    await connect(ids.parent, ids.friend, "FRIEND", ["SPLIT"], ["SPLIT"]);
    const again = await createLinkInvite(ids.friend, { relation: "FRIEND", scopes: ["SPLIT"] });
    if (!again.ok) throw new Error(again.error);
    expect(await acceptLinkInvite(ids.parent, { code: again.code, scopes: ["SPLIT"] })).toMatchObject({ ok: false, code: "DUPLICATE" });
  });

  it("分账只能发自己流水里对得上的花费；收件人在自己的流水里核对同一家店", async () => {
    const link = (await listBlankLinks(ids.parent)).links.find(item => item.otherName === names.friend)!.linkId;
    const sent = await sendBlankMessage(ids.parent, { kind: "SPLIT_REQUEST", linkId: link, items: [
      { date: "2026-11-01", merchant: "漫拿咖啡", amountMinor: 3200, shareMinor: 1600 },
      { date: "2026-10-30", merchant: "书店", amountMinor: 4500, shareMinor: 2250 },
    ] });
    expect(sent).toMatchObject({ ok: true, kind: "SPLIT_REQUEST" });
    expect(await sendBlankMessage(ids.parent, { kind: "SPLIT_REQUEST", linkId: link, items: [
      { date: "2026-11-01", merchant: "火锅店", amountMinor: 9900, shareMinor: 100 },
    ] })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await sendBlankMessage(ids.parent, { kind: "SPLIT_REQUEST", linkId: link, items: [
      { date: "2026-11-01", merchant: "漫拿咖啡", amountMinor: 3200, shareMinor: 5000 },
    ] })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await sendBlankMessage(ids.parent, { kind: "SPLIT_REQUEST", linkId: link, items: [
      { date: "2026-11-01", merchant: "漫拿咖啡", amountMinor: 3200, shareMinor: 1600 },
      { date: "2026-11-01", merchant: "漫拿咖啡", amountMinor: 3200, shareMinor: 1600 },
    ] })).toMatchObject({ ok: false, code: "INVALID" });
    const inbox = await listBlankInbox(ids.friend);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "SPLIT_REQUEST", fromName: names.parent, verification: [
      { merchant: "漫拿咖啡", matchedInYourLedger: true }, { merchant: "书店", matchedInYourLedger: false },
    ] });
  });

  it("朋友之间不能发攒钱请求；攒钱请求只在开放了攒钱的家人之间发", async () => {
    const friendLink = (await listBlankLinks(ids.friend)).links[0].linkId;
    expect(await sendBlankMessage(ids.friend, { kind: "SAVINGS_REQUEST", linkId: friendLink, goal: "玩具", priceMinor: 3000 })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    await connect(ids.parent, ids.second, "FAMILY", ["SAVINGS"], ["SAVINGS"]);
    const savingsLink = (await listBlankLinks(ids.parent)).links.find(item => item.otherName === names.second)!.linkId;
    expect(await sendBlankMessage(ids.second, { kind: "SAVINGS_REQUEST", linkId: savingsLink, goal: "玩具", priceMinor: 3000 })).toMatchObject({ ok: true });
    expect(await sendBlankMessage(ids.parent, { kind: "REWARD", linkId: savingsLink, amountMinor: 1000, reason: "存钱进度" })).toMatchObject({ ok: true });
    const parentInbox = await listBlankInbox(ids.parent);
    expect(parentInbox.find(item => item.kind === "SAVINGS_REQUEST")).toMatchObject({ lines: expect.arrayContaining(["TA 现在的余额 ¥12.00"]) });
    expect((await listBlankInbox(ids.second)).find(item => item.kind === "REWARD")).toBeDefined();
  });

  it("反诈暂缓会通知有反诈提醒授权的家人，只带金额、原因和回电号码，同一笔不重复", async () => {
    const notified = await withTransaction(client => notifyFraudHoldToLinks(client, {
      customerId: ids.parent, operationId: "TRF-20261101-AAAAAAAA", amountMinor: 880000, reasons: ["这是你第一次转给这个人"],
    }));
    expect(notified).toBe(1);
    await withTransaction(client => notifyFraudHoldToLinks(client, {
      customerId: ids.parent, operationId: "TRF-20261101-AAAAAAAA", amountMinor: 880000, reasons: ["这是你第一次转给这个人"],
    }));
    const childInbox = await listBlankInbox(ids.child);
    const alerts = childInbox.filter(item => item.kind === "FRAUD_ALERT");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ title: `${names.parent} 的 Blank 暂缓了一笔转账`, callbackPhone: phones.parent });
    expect(alerts[0].lines).toEqual(expect.arrayContaining(["金额 ¥8800.00"]));
  });

  it("撤销后互相都不能再发，也看不到对方的新消息", async () => {
    const link = (await listBlankLinks(ids.parent)).links.find(item => item.otherName === names.friend)!.linkId;
    expect(await revokeBlankLink(ids.parent, link)).toMatchObject({ ok: true });
    expect(await sendBlankMessage(ids.parent, { kind: "SPLIT_REQUEST", linkId: link, items: [
      { date: "2026-11-01", merchant: "漫拿咖啡", amountMinor: 3200, shareMinor: 1600 },
    ] })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await listBlankInbox(ids.friend)).some(item => item.kind === "SPLIT_REQUEST")).toBe(false);
    expect(await revokeBlankLink(ids.friend, link)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
