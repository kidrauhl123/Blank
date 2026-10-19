"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, RefreshCw } from "lucide-react";
import { bankRequest, BankRequestError } from "@/lib/client-request";
import type { AIModelCatalog } from "@/lib/ai-models";
import { PreferenceSettings } from "./PreferenceSettings";
import styles from "./AppSettings.module.css";

export function AppSettings() {
  const [catalog, setCatalog] = useState<AIModelCatalog | null>(null);
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([bankRequest<AIModelCatalog>("/api/agent/models"), bankRequest<{ model: string | null }>("/api/v1/settings/model")]).then(([models, preference]) => {
      if (!active) return;
      setCatalog(models); setSaved(preference.model ?? models.defaultModel);
      setModel(preference.model && models.models.includes(preference.model) ? preference.model : models.defaultModel);
      setError(preference.model && !models.models.includes(preference.model) ? "已保存的模型当前不可用，请选择其他模型并保存。" : "");
    }).catch((reason) => { if (active) setError(reason instanceof BankRequestError && reason.status === 401 ? "请先进入银行账户。" : "设置暂时无法读取，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!model || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await bankRequest<{ model: string }>("/api/v1/settings/model", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
      setSaved(result.model); setNotice("已保存，新任务将使用此模型。");
    } catch { setError("未能确认设置已保存，请重新读取后核对。"); }
    finally { setSaving(false); }
  };
  return <main className={styles.page}>
    <header className={styles.header}><Link href="/"><ArrowLeft size={18} />返回银行</Link><h1>设置</h1></header>
    <PreferenceSettings />
    <section className={styles.section} aria-labelledby="debug-settings"><h2 id="debug-settings">调试</h2>
      <form className={styles.form} onSubmit={save}>
        <label htmlFor="assistant-model">助手模型</label>
        <div className={styles.select}><select id="assistant-model" disabled={loading || saving || !catalog} value={model} onChange={(event) => { setModel(event.target.value); setNotice(""); }}>
          {!catalog && <option value="">{loading ? "正在读取…" : "暂不可用"}</option>}
          {catalog?.models.map((id) => <option key={id} value={id}>{id}</option>)}
        </select><ChevronDown size={16} aria-hidden="true" /></div>
        <p className={styles.hint}>仅用于当前登录会话的新任务。进行中的任务保持原模型。</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        <div className={styles.actions}><button className={styles.primary} disabled={loading || saving || !catalog || model === saved}>{saving ? "正在保存…" : "保存设置"}</button>
          <button className={styles.secondary} type="button" disabled={loading || saving} onClick={() => { setLoading(true); setNotice(""); setAttempt(attempt + 1); }}><RefreshCw size={16} />重新读取</button></div>
      </form>
    </section>
  </main>;
}
