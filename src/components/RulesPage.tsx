"use client";

import Link from "next/link";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { bankRequest, jsonPost } from "@/lib/client-request";
import type { RuleView } from "@/lib/wallet-store";
import { RULE_STAGE_LABEL, errorText, registerPasskey } from "./RuleCard";
import styles from "./RulesPage.module.css";

type Payment = { recipient: string; amountMinor: number; at: string; ruleId: string };
type Data = {
  balanceMinor: number; caps: { balanceMinor: number; perTxnMinor: number; monthlyMinor: number };
  rules: RuleView[]; payments: Payment[]; auth: { passkeys: number; totp: boolean };
};

const yuan = (minor: number) => `¥${(minor / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

// “规矩与钱包”页：钱包余额与转入转出、规矩列表、最近的钱包付款、Passkey 管理。规矩卡里的确认操作也会触发 blank:rules-changed 让这里重新读取。
export function RulesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  // 同 RuleCard：服务端为 null，只在数据读回后才参与渲染。
  const [webauthn] = useState<boolean | null>(() => typeof window === "undefined" ? null : browserSupportsWebAuthn());
  const [amount, setAmount] = useState("");
  const [passkeyCode, setPasskeyCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/rules", { cache: "no-store" });
    if (response.status === 401 || response.status === 403) { setSignedOut(true); setData(null); return; }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.message ?? "暂时无法读取规矩与钱包。");
    setSignedOut(false); setData(result);
  }, []);
  useEffect(() => {
    const refresh = () => { void load().catch(() => setError("暂时无法读取，请稍后刷新。")); };
    refresh();
    window.addEventListener("blank:rules-changed", refresh);
    return () => window.removeEventListener("blank:rules-changed", refresh);
  }, [load]);

  // 所有写操作共用：同一时间只允许一个；无论成功失败都重新读取，避免界面停在旧状态。
  async function act(work: () => Promise<unknown>, done?: string, cancelled?: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await work();
      if (done) setNotice(done);
    } catch (reason) { setError(errorText(reason, cancelled)); }
    finally {
      pending.current = false; setBusy(false);
      await load().catch(() => undefined);
    }
  }
  function moveMoney(action: "fund" | "withdraw") {
    if (!/^\d+$/.test(amount) || Number(amount) < 1 || Number(amount) > 2000) { setError("请输入 1 到 2000 之间的整数金额。"); return; }
    const amountYuan = Number(amount);
    void act(async () => {
      await bankRequest("/api/v1/wallet", jsonPost({ action, amountYuan }));
      setAmount("");
    }, action === "fund" ? `已转入 ¥${amountYuan}。` : `已收回 ¥${amountYuan}。`);
  }
  const revoke = (id: string) => void act(() => bankRequest(`/api/v1/rules/${encodeURIComponent(id)}`, jsonPost({ action: "revoke" })), "规矩已撤销。");
  const pause = (id: string) => void act(() => bankRequest(`/api/v1/rules/${encodeURIComponent(id)}`, jsonPost({ action: "pause" })), "规矩已暂停。");
  const addPasskey = () => void act(async () => { await registerPasskey(passkeyCode); setPasskeyCode(""); }, "Passkey 已注册。", "已取消，Passkey 没有注册。");

  return <main className={styles.page}>
    <header><Link href="/">← 返回</Link></header>
    <h1>规矩与钱包</h1>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {signedOut ? <p>请先<Link href="/">返回银行选择用户</Link>。</p> : !data ? <p className={styles.muted}>正在读取…</p> : <>
      <section aria-labelledby="wallet-title">
        <h2 id="wallet-title">钱包</h2>
        <p className={styles.balance}><span>余额</span><b>{yuan(data.balanceMinor)}</b></p>
        <p className={styles.muted}>免确认的钱只从这里出，最多放 ¥2,000，损失封顶。</p>
        <div className={styles.transfer}>
          <input inputMode="numeric" pattern="[0-9]*" aria-label="金额（元）" placeholder="整数金额，元" value={amount} onChange={event => setAmount(event.target.value.replace(/\D/g, ""))} disabled={busy} />
          <button disabled={busy} onClick={() => moveMoney("fund")}>转入钱包</button>
          <button disabled={busy} onClick={() => moveMoney("withdraw")}>收回主账户</button>
        </div>
      </section>

      <section aria-labelledby="rules-title">
        <h2 id="rules-title">规矩</h2>
        {!data.rules.length && <p className={styles.muted}>还没有规矩。对 Blank 说“以后给小橘子 100 块以内的转账不用问我”试试。</p>}
        <ul className={styles.list}>{data.rules.map(rule => <li key={rule.id} data-stage={rule.stage}>
          <header><b>{rule.template}</b><span className={styles.tag}>{RULE_STAGE_LABEL[rule.stage]}</span></header>
          <dl>{rule.lines.map((line, index) => <div key={index}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}</dl>
          <small>本月已付 {yuan(rule.monthPaidMinor)}</small>
          {rule.stage === "PAUSED" && rule.pausedReason && <p className={styles.muted}>{rule.pausedReason}</p>}
          {(rule.stage === "COOLING" || rule.stage === "ACTIVE" || rule.stage === "PAUSED") && <div className={styles.actions}>
            {(rule.stage === "COOLING" || rule.stage === "ACTIVE") && <button className={styles.pause} disabled={busy} onClick={() => pause(rule.id)}>暂停</button>}
            <button className={styles.revoke} disabled={busy} onClick={() => revoke(rule.id)}>撤销</button>
          </div>}
        </li>)}</ul>
      </section>

      <section aria-labelledby="payments-title">
        <h2 id="payments-title">最近的钱包付款</h2>
        {!data.payments.length && <p className={styles.muted}>还没有钱包付款。</p>}
        <ul className={styles.list}>{data.payments.map((payment, index) => <li key={`${payment.ruleId}${index}`}>
          <header><b>{payment.recipient}</b><span>{yuan(payment.amountMinor)}</span></header>
          <small>{dateText(payment.at)}</small>
          <small>按你的规矩 · 无需确认</small>
        </li>)}</ul>
      </section>

      <section aria-labelledby="passkey-title">
        <h2 id="passkey-title">Passkey</h2>
        <p className={styles.muted}>已注册 {data.auth.passkeys} 个。确认规矩时用面容 / 指纹验证。</p>
        {webauthn && data.auth.totp && <form className={styles.passkeyForm} onSubmit={event => { event.preventDefault(); if (passkeyCode.length === 6) addPasskey(); }}>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="注册 Passkey 用的动态码" placeholder="6 位动态码" value={passkeyCode} onChange={event => setPasskeyCode(event.target.value.replace(/\D/g, ""))} disabled={busy} />
          <button className={styles.primary} type="submit" disabled={busy || passkeyCode.length !== 6}>注册 Passkey</button>
        </form>}
        {webauthn && !data.auth.totp && <p className={styles.muted}>请先在安全中心设置验证器，才能注册 Passkey。<Link href="/security">去安全中心</Link></p>}
        {webauthn === false && <p className={styles.muted}>当前浏览器不支持 Passkey，可以在<Link href="/security">安全中心</Link>设置验证器。</p>}
      </section>
    </>}
  </main>;
}
