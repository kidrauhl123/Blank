"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { publicDemoProfiles } from "@/lib/demo-catalog";
import styles from "./BankingApp.module.css";

export function AuthScreen({ onAuthenticated, heading, description }: { onAuthenticated: () => Promise<void>; heading?: string; description?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<{ enabled: boolean; profiles: ReturnType<typeof publicDemoProfiles> } | null>(null);
  const loadCatalog = async () => {
    const response = await fetch("/api/auth/demo", { cache: "no-store" });
    if (!response.ok) throw new Error("暂时无法加载用户，请重试。");
    return response.json();
  };
  useEffect(() => {
    let active = true;
    loadCatalog().then((result) => { if (active) setCatalog(result); }).catch(() => { if (active) setError("暂时无法加载用户，请重试。"); });
    return () => { active = false; };
  }, []);
  const choose = async (profileKey: string) => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileKey }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      sessionStorage.removeItem("bankpilot-app-agent-run");
      await onAuthenticated();
    } catch (err) { setError(err instanceof Error ? err.message : "请求未完成"); } finally { setBusy(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      await onAuthenticated();
    } catch (err) { setError(err instanceof Error ? err.message : "请求未完成"); } finally { setBusy(false); }
  };
  return <main className={styles.authStage}><section className={styles.authPanel}>
    <div className={styles.authBrand}><span>B</span><b>BankPilot</b></div>
    {!catalog ? <div className={styles.authCopy}><p>比赛体验沙箱</p><h1>准备好了吗？</h1><span>{error || "正在加载用户…"}</span>{error && <button className={styles.authSubmit} onClick={() => { setError(""); loadCatalog().then(setCatalog).catch(() => setError("暂时无法加载用户，请重试。")); }}>重新加载</button>}</div> : catalog.enabled ? <>
      <div className={`${styles.authCopy} ${styles.demoCopy}`}><p>比赛体验沙箱</p><h1>今天，你是谁？</h1><span>选一位小伙伴，直接开始体验。</span></div>
      <div className={styles.demoProfiles} aria-label="选择模拟用户">{catalog.profiles.map((profile) => <button key={profile.key} className={styles.demoProfile} aria-label={`以${profile.name}进入`} disabled={busy} onClick={() => choose(profile.key)}>
        <span className={styles.demoAvatar} style={{ background: profile.color }} aria-hidden="true">{profile.emoji}</span><span className={styles.demoPerson}><b>{profile.name}<small>{profile.role}</small></b><span>{profile.description}</span></span><span aria-hidden="true">→</span>
      </button>)}</div>
      {error && <div className={styles.formError} role="alert">{error}</div>}
      <p className={styles.demoHint} aria-live="polite">{busy ? "正在进入账户…" : `${catalog.profiles.length} 位模拟用户共享沙箱数据，已备好余额、账单、卡片和订阅，可互相转账。`}</p>
    </> : <>
    <div className={styles.authCopy}><p>账户与日常收支</p><h1>{mode === "login" ? heading ?? "欢迎回来" : "开立你的账户"}</h1><span>{description ?? (mode === "login" ? "登录后管理账户、转账和账单。" : "从零开始，所有数据都由你亲自创建。")}</span></div>
    <form onSubmit={submit} className={styles.authForm}>
      {mode === "register" && <label>姓名<input name="displayName" autoComplete="name" minLength={2} required placeholder="你的真实姓名或测试代号" /></label>}
      <label>手机号<input name="phone" autoComplete="tel" inputMode="tel" required placeholder="用于登录和收款人识别" /></label>
      <label>密码<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "register" ? 10 : 1} required placeholder={mode === "register" ? "至少 10 位，包含字母和数字" : "输入密码"} /></label>
      {error && <div className={styles.formError} role="alert">{error}</div>}
      <button className={styles.authSubmit} disabled={busy}>{busy ? "正在验证…" : mode === "login" ? "安全登录" : "注册并开户"}</button>
    </form>
    <button className={styles.modeSwitch} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "还没有账户？立即注册" : "已有账户？返回登录"}</button>
    </>}
    <small className={styles.authLegal}>比赛沙箱，不连接真实银行与清算网络。</small>
  </section></main>;
}
