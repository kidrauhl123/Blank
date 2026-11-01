"use client";

import { useEffect, useState, type FormEvent } from "react";
import { bankRequest, BankRequestError } from "@/lib/client-request";
import styles from "./AppSettings.module.css";

type KeyStatus = { configured: boolean; baseUrl: string | null; model: string | null; keyHint: string | null; updatedAt: string | null };

function hostOf(url: string | null) {
  try { return url ? new URL(url).host : ""; } catch { return ""; }
}

// 访客自己的模型接口。密钥只在提交时发送；保存后服务器不再返回，页面也不再显示。
export function ModelKeyForm({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    bankRequest<KeyStatus>("/api/v1/settings/model-key")
      .then((result) => { if (active) setStatus(result); })
      .catch(() => { if (active) setError("自定义模型设置暂时无法读取。"); });
    return () => { active = false; };
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await bankRequest<KeyStatus>("/api/v1/settings/model-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl, apiKey, model }) });
      setStatus(result); setApiKey(""); setNotice("已验证并保存。密钥加密保存在服务器，之后不会再显示。");
      onChanged?.();
    } catch (reason) {
      setApiKey("");
      setError(reason instanceof BankRequestError ? reason.message : "未能保存，请重试。");
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      setStatus(await bankRequest<KeyStatus>("/api/v1/settings/model-key", { method: "DELETE" }));
      setNotice("已删除自定义模型设置。");
      onChanged?.();
    } catch {
      setError("未能删除，请重新读取后核对。");
    } finally { setBusy(false); }
  };
  return <>
    {status?.configured && <p className={styles.status}>当前使用：{hostOf(status.baseUrl)} · {status.model} · 密钥尾号 {status.keyHint}</p>}
    <p className={styles.hint}>填写你自己的 OpenAI 兼容接口（需要支持 /models）。地址必须是公开的 https 地址；密钥加密保存，只用于你的对话。</p>
    <form className={styles.form} onSubmit={save}>
      <label htmlFor="model-base-url">接口地址</label>
      <input id="model-base-url" className={styles.input} type="url" inputMode="url" autoComplete="off" placeholder="https://example.com/v1" value={baseUrl} disabled={busy || !status} onChange={(event) => setBaseUrl(event.target.value)} required />
      <label htmlFor="model-api-key">API 密钥</label>
      <input id="model-api-key" className={styles.input} type="password" autoComplete="new-password" spellCheck={false} value={apiKey} disabled={busy || !status} onChange={(event) => setApiKey(event.target.value)} required />
      <label htmlFor="model-name">模型名称</label>
      <input id="model-name" className={styles.input} type="text" autoComplete="off" spellCheck={false} placeholder="例如 gpt-4o-mini" value={model} disabled={busy || !status} onChange={(event) => setModel(event.target.value)} required />
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
      <div className={styles.actions}>
        <button className={styles.primary} disabled={busy || !status}>{busy ? "正在验证…" : "验证并保存"}</button>
        {status?.configured && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void remove()}>删除</button>}
      </div>
    </form>
  </>;
}
