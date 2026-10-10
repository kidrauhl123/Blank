"use client";

import { ArrowLeft, Check, Clipboard, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { bankRequest, BankRequestError, jsonPost } from "@/lib/client-request";
import styles from "./SecurityCenter.module.css";

type Setup = { secret: string; uri: string };
type Account = { display_name: string; demo?: boolean; mfa_configured: boolean };

export function SecurityCenter() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [demoConfirmed, setDemoConfirmed] = useState(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await bankRequest<{ customer: Account }>("/api/bootstrap");
      setAccount(result.customer); setError(""); setUncertain(false);
      if (result.customer.mfa_configured) setSetup(null);
    } catch (reason) {
      setAccount(null);
      if (reason instanceof BankRequestError && reason.status === 401) router.replace("/");
      setError("安全设置暂时无法读取，请重试。");
    } finally { setLoading(false); }
  }, [router]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const begin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !account || account.mfa_configured) return;
    const form = new FormData(event.currentTarget);
    pending.current = true; setBusy(true); setError("");
    try {
      setSetup(await bankRequest<Setup>("/api/v1/security/totp/setup", jsonPost(account.demo ? { demoConfirmed } : { password: form.get("password") })));
      setCopied(false);
    } catch (reason) { setError(reason instanceof BankRequestError ? reason.message : "设置未完成，请重新读取安全状态。"); }
    finally { pending.current = false; setBusy(false); }
  };
  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || uncertain) return;
    const form = new FormData(event.currentTarget);
    pending.current = true; setBusy(true); setError("");
    try {
      await bankRequest("/api/v1/security/totp/confirm", jsonPost({ code: form.get("code") }));
      setDone(true); setAccount(current => current ? { ...current, mfa_configured: true } : current); setSetup(null);
    } catch (reason) {
      setError(reason instanceof BankRequestError ? reason.message : "启用结果暂时无法确认，请重新读取安全状态。");
      setUncertain(!(reason instanceof BankRequestError) || reason.outcomeUnknown);
    } finally { pending.current = false; setBusy(false); }
  };
  const copySecret = async () => {
    if (!setup) return;
    try { await navigator.clipboard.writeText(setup.secret); setCopied(true); }
    catch { setError("复制未完成，请手动输入下方密钥。"); }
  };

  return <main className={styles.page}><header><Link href="/"><ArrowLeft size={17} />返回银行</Link><div><span>B</span><b>安全中心</b></div></header><section className={styles.card}>
    <div className={styles.icon}><ShieldCheck size={25} /></div><p>保护敏感操作</p><h1>设置身份验证器</h1><span>添加验证器后，按要求输入它生成的 6 位动态码。密钥和动态码不会共享给助手。</span>
    {loading ? <p role="status">正在读取安全状态…</p> : !account ? <><p role="alert">{error}</p><button className={styles.retry} onClick={() => void load()}><RefreshCw size={16} />重新读取</button></> : <>
      {account.demo && <div className={styles.demoNotice}><b>{account.display_name} · 共享模拟账户</b><span>此设置仅用于演示真实动态码验证，不代表真实身份核验。你设置的验证器会影响使用同一模拟账户的其他体验者。</span></div>}
      {account.mfa_configured && !setup ? <div className={styles.enabled} role="status"><Check size={19} /><div><b>{done ? "验证器启用成功" : "验证器已启用"}</b><span>需要强验证时，请使用已绑定验证器的动态码。当前入口不支持覆盖已有验证器。</span></div></div> : !setup ? <form onSubmit={begin} aria-busy={busy}>
        {account.demo ? <label className={styles.confirmDemo}><input type="checkbox" checked={demoConfirmed} onChange={event => setDemoConfirmed(event.target.checked)} disabled={busy} required />我了解这是共享模拟账户，确认设置验证器。</label> : <label>登录密码<input name="password" type="password" autoComplete="current-password" disabled={busy} required /><small>先确认账户身份，再设置验证器。</small></label>}
        {error && <em role="alert">{error}</em>}<button disabled={busy || (account.demo && !demoConfirmed)}><KeyRound size={16} />{busy ? "正在准备设置…" : "开始设置"}</button>
      </form> : <div className={styles.setup} data-agent-private><h2>添加到你的身份验证器</h2><ol><li>打开支持动态码的身份验证器。</li><li>选择手动添加，账户名称填写 BankPilot。</li><li>输入下方密钥，再填写生成的动态码完成启用。</li></ol><div className={styles.secret}><code>{setup.secret}</code><button onClick={() => void copySecret()} aria-label={copied ? "密钥已复制" : "复制验证器密钥"}><Clipboard size={15} /></button></div>{copied && <small role="status">密钥已复制。</small>}<details><summary>使用验证器导入链接</summary><code>{setup.uri}</code></details><form onSubmit={confirm} aria-busy={busy}><label>6 位动态码<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" disabled={busy || uncertain} required autoFocus /></label>{error && <em role="alert">{error}</em>}<button disabled={busy || uncertain}>{busy ? "正在启用…" : "确认并启用"}</button></form>{uncertain && <button className={styles.retry} disabled={loading} onClick={() => void load()}>重新读取启用结果</button>}</div>}
    </>}
  </section></main>;
}
