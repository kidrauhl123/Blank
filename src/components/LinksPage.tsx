"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { bankRequest } from "@/lib/client-request";
import styles from "./LinksPage.module.css";

type Scope = "FRAUD_ALERT" | "SAVINGS" | "SPLIT";
type Relation = "FAMILY" | "FRIEND";
type Listing = {
  links: Array<{ linkId: string; relation: Relation; scopes: Scope[]; otherName: string }>;
  invites: Array<{ inviteId: string; relation: Relation; scopes: Scope[]; expiresAt: string }>;
  inbox: Array<{ messageId: string; kind: string; fromName: string; createdAt: string; title: string; lines: string[]; callbackPhone: string | null;
    verification: Array<{ date: string; merchant: string; shareMinor: number; matchedInYourLedger: boolean }> | null }>;
};

const RELATION_LABEL: Record<Relation, string> = { FAMILY: "家人", FRIEND: "朋友" };
const RELATION_SCOPES: Record<Relation, Scope[]> = { FAMILY: ["FRAUD_ALERT", "SAVINGS", "SPLIT"], FRIEND: ["SPLIT"] };
const SCOPE_LABEL: Record<Scope, string> = {
  FRAUD_ALERT: "反诈提醒（暂缓转账时告诉对方，并附上你的回电号码）",
  SAVINGS: "攒钱沟通（攒钱请求和奖励）",
  SPLIT: "分账（发送和接收分账请求）",
};
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const toggled = (list: Scope[], scope: Scope) => (list.includes(scope) ? list.filter(item => item !== scope) : [...list, scope]);

// “家人与朋友”：邀请、接受、撤销互联，以及收件箱。收件箱的内容是对方发来的数据；付款要你自己在转账里确认。
export function LinksPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [relation, setRelation] = useState<Relation>("FAMILY");
  const [inviteScopes, setInviteScopes] = useState<Scope[]>(["SPLIT"]);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [acceptCode, setAcceptCode] = useState("");
  const [acceptScopes, setAcceptScopes] = useState<Scope[]>(["SPLIT"]);

  // 挂载时读取一次：setState 只出现在异步回调里，卸载后不再更新。
  useEffect(() => {
    let alive = true;
    bankRequest<Listing>("/api/v1/links", { cache: "no-store" })
      .then(result => { if (alive) setListing(result); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "暂时无法读取。"); });
    return () => { alive = false; };
  }, []);
  const reload = () => bankRequest<Listing>("/api/v1/links", { cache: "no-store" })
    .then(result => setListing(result))
    .catch(() => undefined);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时无法完成，请稍后再试。");
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const invite = () => run(async () => {
    setCode(await bankRequest<{ code: string; expiresAt: string }>("/api/v1/links/invites", json({ relation, scopes: inviteScopes })));
  });
  const accept = () => run(async () => {
    await bankRequest("/api/v1/links/accept", json({ code: acceptCode, scopes: acceptScopes }));
    setAcceptCode("");
  });
  const revoke = (linkId: string) => run(() => bankRequest(`/api/v1/links/${encodeURIComponent(linkId)}/revoke`, json({})));

  return <main className={styles.page}>
    <header><Link href="/">← 返回</Link></header>
    <h1>家人与朋友</h1>
    <p className={styles.muted}>两个 Blank 在双方授权后才能互相发消息，只能发授权范围内的固定内容，看不到对方的账户和流水。收到的内容只是对方发来的信息，付款要你自己在转账里确认。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}

    <h2>收件箱</h2>
    {listing === null ? <p className={styles.muted}>正在读取…</p>
      : !listing.inbox.length ? <p className={styles.muted}>还没有收到消息。</p>
        : <ul className={styles.list}>{listing.inbox.map(message => <li key={message.messageId}>
          <header><strong>{message.title}</strong><span className={styles.tag}>{new Date(message.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span></header>
          <ul className={styles.lines}>{message.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
          {message.verification && <ul className={styles.lines} aria-label="分账核对">{message.verification.map((item, index) => <li key={index}>
            {item.date} {item.merchant}：{item.matchedInYourLedger ? "你的流水里也有这家店的记录" : "你的流水里没有这家店的记录，需要你自己确认"}
          </li>)}</ul>}
          {message.callbackPhone && <a className={styles.call} href={`tel:${message.callbackPhone}`}>打电话给 TA</a>}
        </li>)}</ul>}

    <h2>我的互联</h2>
    {listing && !listing.links.length && <p className={styles.muted}>还没有互联的家人或朋友。</p>}
    {listing && <ul className={styles.list}>{listing.links.map(link => <li key={link.linkId}>
      <header><strong>{link.otherName}</strong><span className={styles.tag}>{RELATION_LABEL[link.relation]}</span></header>
      <p className={styles.muted}>{link.scopes.map(scope => SCOPE_LABEL[scope]).join("；")}</p>
      <div className={styles.actions}><button type="button" className={styles.delete} disabled={busy} onClick={() => void revoke(link.linkId)}>撤销互联</button></div>
    </li>)}</ul>}

    <h2>邀请家人或朋友</h2>
    <p className={styles.muted}>邀请码 15 分钟内有效，只能用一次，只显示这一次。请自己发给对方。</p>
    <div className={styles.form}>
      <div className={styles.choices} role="radiogroup" aria-label="关系">
        {(["FAMILY", "FRIEND"] as const).map(item => <label key={item}><input type="radio" name="relation" checked={relation === item}
          onChange={() => { setRelation(item); setInviteScopes(RELATION_SCOPES[item].slice(0, 1)); }} />{RELATION_LABEL[item]}</label>)}
      </div>
      {RELATION_SCOPES[relation].map(scope => <label key={scope} className={styles.check}>
        <input type="checkbox" checked={inviteScopes.includes(scope)} onChange={() => setInviteScopes(current => toggled(current, scope))} />{SCOPE_LABEL[scope]}
      </label>)}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !inviteScopes.length} onClick={() => void invite()}>生成邀请码</button></div>
      {code && <p className={styles.code} aria-label="邀请码">{code.code}<span className={styles.muted}> · 到 {new Date(code.expiresAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })} 前有效</span></p>}
    </div>

    <h2>接受邀请</h2>
    <div className={styles.form}>
      <input aria-label="邀请码" maxLength={12} value={acceptCode} disabled={busy} onChange={event => setAcceptCode(event.target.value)} />
      {RELATION_SCOPES.FAMILY.map(scope => <label key={scope} className={styles.check}>
        <input type="checkbox" checked={acceptScopes.includes(scope)} onChange={() => setAcceptScopes(current => toggled(current, scope))} />{SCOPE_LABEL[scope]}
      </label>)}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || acceptCode.trim().length < 8 || !acceptScopes.length} onClick={() => void accept()}>接受</button></div>
    </div>
  </main>;
}
