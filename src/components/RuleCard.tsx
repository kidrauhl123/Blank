"use client";

import { startAuthentication, startRegistration, browserSupportsWebAuthn, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { bankRequest, jsonPost } from "@/lib/client-request";
import type { RuleView } from "@/lib/wallet-store";
import { AssistantMark } from "./AssistantMark";
import styles from "./RuleCard.module.css";

export const RULE_STAGE_LABEL = { DRAFT: "等你本人确认", COOLING: "冷静期中", ACTIVE: "已生效", PAUSED: "已暂停", REVOKED: "已撤销", DISMISSED: "已放弃" } as const;
const AUTHORIZED_BY = { PASSKEY: "Passkey", TOTP: "验证器" } as const;
const CANCELLED = "已取消，规矩没有生效。";
const effectiveText = (iso: string) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" }).format(new Date(iso));

// 用户在系统弹窗里取消（NotAllowedError）不算失败，给一句明确的说明。
export function errorText(reason: unknown, cancelled = CANCELLED) {
  if ((reason as { name?: string } | null)?.name === "NotAllowedError") return cancelled;
  return reason instanceof Error ? reason.message : "暂时无法完成，请稍后再试。";
}

// 注册 Passkey：服务端在发挑战时就会核验并作废动态码，所以要先拿到动态码；之后再由系统完成面容 / 指纹，最后交给服务端验证。规矩卡和“规矩与钱包”页共用。
export async function registerPasskey(totpCode: string) {
  const options = await bankRequest<PublicKeyCredentialCreationOptionsJSON>("/api/v1/passkeys", jsonPost({ step: "register-options", totpCode }));
  const response = await startRegistration({ optionsJSON: options });
  await bankRequest("/api/v1/passkeys", jsonPost({ step: "register-verify", response }));
}

// 对话里的“规矩卡”：文案全部来自服务端的 lines / template，这里只负责展示和确认动作。
export function RuleCardById({ id }: { id: string }) {
  const [view, setView] = useState<RuleView | "missing" | null>(null);
  // 服务端渲染时为 null；这个值只在卡片数据读回后才用于渲染，所以不会和客户端首屏不一致。
  const [supported] = useState<boolean | null>(() => typeof window === "undefined" ? null : browserSupportsWebAuthn());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [passkeyCode, setPasskeyCode] = useState("");
  const load = () => fetch(`/api/v1/rules/${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(async response => { const result = await response.json().catch(() => null); setView(response.ok && result?.rule ? result.rule : "missing"); })
    .catch(() => setView("missing"));
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (view === null) return <p className={styles.empty} aria-busy="true">正在读取规矩…</p>;
  if (view === "missing") return <p className={styles.empty}>这条规矩已经失效或暂时无法读取。</p>;

  const run = async (work: () => Promise<unknown>, cancelled?: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await work();
      await load();
      window.dispatchEvent(new Event("blank:rules-changed"));
    } catch (reason) {
      setError(errorText(reason, cancelled));
      await load();
    } finally { setBusy(false); }
  };
  const authorizeByPasskey = () => run(async () => {
    const options = await bankRequest<PublicKeyCredentialRequestOptionsJSON>("/api/v1/passkeys", jsonPost({ step: "auth-options", ruleId: id }));
    const response = await startAuthentication({ optionsJSON: options });
    await bankRequest(`/api/v1/rules/${encodeURIComponent(id)}`, jsonPost({ action: "authorize", method: "passkey", response }));
  });
  const authorizeByTotp = () => {
    if (!/^\d{6}$/.test(code)) { setError("请输入 6 位数字动态码。"); return; }
    void run(async () => {
      await bankRequest(`/api/v1/rules/${encodeURIComponent(id)}`, jsonPost({ action: "authorize", method: "totp", code }));
      setCode("");
    });
  };
  const decide = (body: { action: "dismiss" | "revoke" | "pause" }) => run(() => bankRequest(`/api/v1/rules/${encodeURIComponent(id)}`, jsonPost(body)));
  const registerThenReload = () => run(async () => { await registerPasskey(passkeyCode); setPasskeyCode(""); }, "已取消，Passkey 没有注册。");
  const pause = <button disabled={busy} onClick={() => void decide({ action: "pause" })}>暂停这条规矩</button>;
  const revoke = <button disabled={busy} onClick={() => void decide({ action: "revoke" })}>撤销这条规矩</button>;

  const { auth, stage } = view;
  const webauthnReady = supported === true;
  const canAuthorizeByPasskey = webauthnReady && auth.passkeys > 0;
  const canRegisterPasskey = webauthnReady && auth.passkeys === 0;
  const noMethod = supported !== null && !canAuthorizeByPasskey && !canRegisterPasskey && !auth.totp;
  const title = {
    DRAFT: "新规矩 · 等你本人确认",
    COOLING: `已确认（${view.authorizedBy ? AUTHORIZED_BY[view.authorizedBy] : "Passkey / 验证器"}）· 将在 ${view.effectiveAt ? effectiveText(view.effectiveAt) : "—"}（北京时间）生效`,
    ACTIVE: "已生效",
    PAUSED: "已暂停",
    REVOKED: "已撤销",
    DISMISSED: "已放弃",
  }[stage];

  return <article className={styles.card} aria-label={`规矩：${view.template}`} data-stage={stage}>
    <header><span className={styles.kind}>{view.template}</span><span className={styles.status}>{RULE_STAGE_LABEL[stage]}</span></header>
    <h3>{title}</h3>
    <dl className={styles.lines}>{view.lines.map((line, index) => <div key={index}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}</dl>
    {stage === "DRAFT" && <>
      <p className={styles.note}>确认要你本人验证（面容 / 指纹），确认后还有 24 小时冷静期才生效。</p>
      {canAuthorizeByPasskey && <button className={styles.primary} disabled={busy} onClick={() => void authorizeByPasskey()}>用面容 / 指纹确认</button>}
      {canRegisterPasskey && auth.totp && <form className={styles.passkey} onSubmit={event => { event.preventDefault(); if (passkeyCode.length === 6) void registerThenReload(); }}>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="注册 Passkey 用的动态码" placeholder="6 位动态码" value={passkeyCode} onChange={event => setPasskeyCode(event.target.value.replace(/\D/g, ""))} disabled={busy} />
        <button type="submit" disabled={busy || passkeyCode.length !== 6}>注册 Passkey（面容 / 指纹）</button>
      </form>}
      {canRegisterPasskey && !auth.totp && <p className={styles.note}>请先在安全中心设置验证器，才能注册 Passkey。<a href="/security">去安全中心</a></p>}
      {auth.totp && <form className={styles.totp} onSubmit={event => { event.preventDefault(); authorizeByTotp(); }}>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="确认规矩用的动态码" placeholder="6 位动态码" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} disabled={busy} />
        <button type="submit" disabled={busy}>改用验证器动态码</button>
      </form>}
      {noMethod && <p className={styles.note}>还没有可用的强验证方式。<a href="/security">去设置验证器</a></p>}
      <footer className={styles.footer}><span className={styles.byline}><AssistantMark size={14} />点确认才会生效</span>
        <span className={styles.actions}><button disabled={busy} onClick={() => void decide({ action: "dismiss" })}>不要</button></span>
      </footer>
    </>}
    {stage === "COOLING" && <footer className={styles.footer}>
      <span className={styles.byline}>冷静期里这条规矩不会生效。不是你本人？</span>
      <span className={styles.actions}>{pause}{revoke}</span>
    </footer>}
    {(stage === "ACTIVE" || stage === "PAUSED") && <>
      {stage === "PAUSED" && view.pausedReason && <p className={styles.note}>{view.pausedReason}</p>}
      <footer className={styles.footer}><span className={styles.byline}>{stage === "ACTIVE" ? "已生效，可随时撤销" : "已暂停"}</span><span className={styles.actions}>{stage === "ACTIVE" && pause}{revoke}</span></footer>
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </article>;
}
