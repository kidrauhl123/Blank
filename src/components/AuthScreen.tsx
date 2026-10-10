"use client";

import { useEffect, useState } from "react";
import type { publicDemoProfiles } from "@/lib/demo-catalog";
import styles from "./BankingApp.module.css";

type Profiles = ReturnType<typeof publicDemoProfiles>;
export function AuthScreen({ onAuthenticated }: { onAuthenticated: () => Promise<void>; heading?: string; description?: string }) {
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadProfiles = async () => {
    const response = await fetch("/api/auth/demo", { cache: "no-store" });
    if (!response.ok) throw new Error("暂时无法加载用户，请重试。");
    return (await response.json()).profiles as Profiles;
  };
  useEffect(() => {
    let active = true;
    loadProfiles().then((result) => { if (active) setProfiles(result); }).catch(() => { if (active) setError("暂时无法加载用户，请重试。"); });
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
  return <main className={styles.authStage}><section className={styles.authPanel}>
    <div className={styles.authBrand}><span>B</span><b>BankPilot</b></div>
    <div className={`${styles.authCopy} ${styles.demoCopy}`}><h1>选个小伙伴</h1><span>点击头像，开始体验。</span></div>
    {profiles ? <div className={styles.demoProfiles} aria-label="选择用户" aria-busy={busy}>{profiles.map((profile) => <button key={profile.key} className={styles.demoProfile} aria-label={`以${profile.name}进入`} disabled={busy} onClick={() => choose(profile.key)}>
      <span className={styles.demoAvatar} style={{ background: profile.color }} aria-hidden="true">{profile.emoji}</span><b className={styles.demoPerson}>{profile.name}</b><span aria-hidden="true">→</span>
    </button>)}</div> : <p className={styles.demoHint}>{error ? "" : "正在加载用户…"}</p>}
    {error && <div className={styles.formError} role="alert">{error}</div>}
    {!profiles && error && <button className={styles.authSubmit} onClick={() => { setError(""); loadProfiles().then(setProfiles).catch(() => setError("暂时无法加载用户，请重试。")); }}>重新加载</button>}
    {busy && <p className={styles.demoHint} aria-live="polite">正在进入…</p>}
    <small className={styles.authLegal}>模拟账户共享测试数据，不连接真实银行。</small>
  </section></main>;
}
