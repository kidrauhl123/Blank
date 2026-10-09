"use client";

import { ArrowLeft, ChevronRight, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import type { ChannelSetup } from "@/lib/channel-onboarding";
import { ChannelOnboarding } from "./ChannelOnboarding";
import styles from "./ChannelSettings.module.css";

type Identity = { id: string; channel_type: ChannelSetup["channelType"]; status: "ACTIVE" | "REVOKED"; bound_at: string; last_seen_at: string | null };

export function ChannelSettings() {
  const [providers, setProviders] = useState<ChannelSetup[]>([]);
  const [channels, setChannels] = useState<Identity[]>([]);
  const [selected, setSelected] = useState<ChannelSetup["channelType"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const provider = providers.find(item => item.channelType === selected);

  const load = useCallback(async () => {
    try {
      const [setupResponse, identityResponse] = await Promise.all([
        fetch("/api/v1/channels/onboarding", { cache: "no-store" }),
        fetch("/api/v1/channels", { cache: "no-store" }),
      ]);
      if (!setupResponse.ok) throw new Error("暂时无法读取机器人入口。");
      const setup = await setupResponse.json();
      setProviders(setup.providers);
      if (identityResponse.status === 401) {
        setSignedOut(true); setChannels([]); setError(""); return;
      }
      const result = await identityResponse.json();
      if (!identityResponse.ok) throw new Error(result.message ?? "暂时无法读取渠道绑定。");
      setChannels(result.channels); setSignedOut(false); setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "暂时无法读取连接。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const requested = new URLSearchParams(location.search).get("channel")?.toUpperCase();
      if (requested === "QQ" || requested === "WECOM") setSelected(requested);
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = selected && !signedOut ? window.setInterval(refresh, 8000) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [load, selected, signedOut]);

  const revoke = async (identity: Identity) => {
    if (!window.confirm("解除这个聊天身份与当前银行账户的绑定？")) return;
    setBusy(identity.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/channels", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityId: identity.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "解除绑定失败，请重试。");
      setChannels(items => items.map(item => item.id === identity.id ? { ...item, status: "REVOKED" } : item));
      setNotice("已解除绑定，该聊天身份不能再访问你的银行账户。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "解除绑定失败，请重试。");
    } finally {
      setBusy(null);
    }
  };

  return <main className={styles.stage}><section className={styles.panel}>
    <header><Link href="/"><ArrowLeft size={18} /> 返回</Link><div><span>B</span><b>BankPilot</b></div></header>
    <div className={styles.heading}><h1>在聊天里办银行的事。</h1><span>添加 BankPilot 官方机器人，绑定你的银行账户后即可开始对话。</span></div>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => void load()} aria-label="刷新连接状态"><RefreshCw size={18} /></button></div>}
    {notice && <p className={styles.waiting} role="status">{notice}</p>}
    {loading ? <p className={styles.empty}>正在读取连接…</p> : signedOut ? <div className={styles.guide}>
      <h2>先登录你的银行账户</h2><p className={styles.guideCopy}>登录后查看和管理你的聊天身份绑定。</p><Link href="/" className={styles.primary}>去登录</Link>
    </div> : <>
      {provider ? <ChannelOnboarding key={provider.channelType} provider={provider} bound={channels.some(item => item.channel_type === provider.channelType && item.status === "ACTIVE")} onRefresh={load} onClose={() => setSelected(null)} /> : <div className={styles.providers}>
        {providers.map(item => {
          const bound = channels.some(identity => identity.channel_type === item.channelType && identity.status === "ACTIVE");
          return <button key={item.channelType} onClick={() => setSelected(item.channelType)}>
            <Image src={item.channelType === "QQ" ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={34} height={34} />
            <span><b>{item.name}</b><small>{bound ? "已绑定到当前账户" : item.canStart ? "添加官方机器人，确认账户绑定" : "暂未开放接入"}</small></span><ChevronRight size={20} />
          </button>;
        })}
      </div>}
      {channels.length > 0 && <><h2 className={styles.listTitle}>我的聊天身份</h2><div className={styles.list}>{channels.map(identity => <article key={identity.id}>
        <div className={styles.channelMark}><Image src={identity.channel_type === "QQ" ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={28} height={28} /></div>
        <div><b>{identity.channel_type === "QQ" ? "QQ" : "企业微信"}</b><small>{identity.status === "ACTIVE" ? "已绑定" : "已解除绑定"}</small><small>绑定于 {new Date(identity.bound_at).toLocaleDateString("zh-CN")}</small></div>
        {identity.status === "ACTIVE" ? <button disabled={busy !== null} onClick={() => void revoke(identity)}><Unplug size={15} />{busy === identity.id ? "处理中…" : "解除绑定"}</button> : <span className={styles.revoked}>已撤销</span>}
      </article>)}</div></>}
    </>}
    <div className={styles.rule}><ShieldCheck size={21} /><span><b>操作前，由你确认</b><small>敏感操作会要求确认或回到银行 APP 完成强验证。</small></span></div>
    <footer><ShieldCheck size={15} /> 银行业务仅支持机器人私聊</footer>
  </section></main>;
}
