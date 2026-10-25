"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { bankRequest, BankRequestError } from "@/lib/client-request";
import type { PreferenceKey, PreferenceState } from "@/lib/visitor-preferences";
import styles from "./AppSettings.module.css";

type Drafts = Record<PreferenceKey, string>;
type PreferenceSnapshot = PreferenceState & { scopeTag: string };
const emptyDrafts: Drafts = { preferred_name: "", response_language: "", response_detail: "" };
const endpoint = "/api/v1/preferences";

function requestError(error: unknown) {
  if (error instanceof BankRequestError) {
    if (error.status === 401 || error.status === 403) return "请返回银行首页，重新选择用户后再试。";
    return error.message;
  }
  return "偏好暂时无法读取，请稍后重试。";
}

export function PreferenceSettings() {
  const [state, setState] = useState<PreferenceSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const applySnapshot = useCallback((next: PreferenceSnapshot) => {
    setState(next);
    setDrafts({
      preferred_name: next.preferences.preferred_name?.value ?? "",
      response_language: next.preferences.response_language?.value ?? "",
      response_detail: next.preferences.response_detail?.value ?? "",
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await bankRequest<PreferenceSnapshot>(endpoint);
      applySnapshot(next);
      setError("");
      return true;
    } catch (reason) {
      setState(null);
      setError(requestError(reason));
      return false;
    } finally { setLoading(false); }
  }, [applySnapshot]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  const mutate = async (method: "PUT" | "DELETE" | "PATCH", body: Record<string, unknown>, success: string, key?: PreferenceKey) => {
    if (!state || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await bankRequest<PreferenceSnapshot>(endpoint, {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, expectedVersion: state.version, expectedScope: state.scopeTag }),
      });
      setState(next);
      if (key) setDrafts((current) => ({ ...current, [key]: next.preferences[key]?.value ?? "" }));
      else applySnapshot(next);
      setNotice(success);
    } catch (reason) {
      if (reason instanceof BankRequestError && (reason.status === 409 || reason.outcomeUnknown)) {
        const refreshed = await reload();
        setError(refreshed
          ? reason.code === "PREFERENCE_SCOPE_CHANGED" ? "用户已切换，已重新读取对应偏好。请检查后再操作。"
            : reason.status === 409 ? "偏好已在别处更新，已重新读取。请检查后再操作。" : "未能确认操作结果，已重新读取当前状态；请核对后再操作。"
          : "未能确认操作结果，也无法重新读取。请稍后刷新核对，避免重复操作。");
      } else setError(requestError(reason));
    } finally { setBusy(false); }
  };

  const save = (key: PreferenceKey) => mutate("PUT", { key, value: drafts[key] }, "偏好已保存，后续助手回复会按此设置调整。", key);
  const remove = (key: PreferenceKey) => mutate("DELETE", { key }, "这项偏好已删除，后续助手回复不会再读取它。", key);
  const clear = () => {
    if (!window.confirm("确定清空当前用户下的全部回复偏好吗？此操作不能撤销。")) return;
    void mutate("DELETE", { all: true }, "当前用户下的偏好已清空。");
  };

  const canEdit = Boolean(state?.enabled) && !loading && !busy;
  const row = (key: PreferenceKey, label: string, control: React.ReactNode) => <div className={styles.preferenceRow} key={key}>
    <label htmlFor={`preference-${key}`}>{label}</label>
    {control}
    <div className={styles.preferenceActions}>
      <button type="button" className={styles.primary} disabled={!canEdit || !drafts[key].trim() || drafts[key] === (state?.preferences[key]?.value ?? "")}
        onClick={() => void save(key)}>保存</button>
      <button type="button" className={styles.secondary} disabled={!canEdit || !state?.preferences[key]}
        onClick={() => void remove(key)}>删除此项</button>
    </div>
  </div>;

  return <section className={styles.section} aria-labelledby="preference-settings">
    <h2 id="preference-settings">回复偏好</h2>
    <p className={styles.hint}>只影响助手的称呼、语言和说明详略，不影响账户身份、金额或转账确认。偏好仅属于当前浏览器与当前用户，保存后 90 天过期。</p>
    {loading && <p role="status" className={styles.hint}>正在读取偏好…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {!state && !loading && <button type="button" className={styles.secondary} onClick={() => void reload()}><RefreshCw size={16} />重新读取</button>}
    {state && <>
      <div className={styles.memoryControl}>
        <div><strong>长期偏好记忆</strong><p className={styles.hint}>{state.enabled ? "已开启，助手会读取有效偏好。" : `已关闭，助手不会读取偏好；仍保留 ${state.retainedCount} 项，可重新开启或清空。`}</p></div>
        <button type="button" className={styles.secondary} disabled={loading || busy}
          onClick={() => void mutate("PATCH", { enabled: !state.enabled }, state.enabled ? "已关闭偏好记忆；已有数据仍保留，可单独清空。" : "已开启偏好记忆。")}>{state.enabled ? "关闭记忆" : "开启记忆"}</button>
      </div>
      {state.enabled && <div className={styles.preferenceFields}>
        {row("preferred_name", "希望如何称呼你", <input id="preference-preferred_name" type="text" autoComplete="off" maxLength={40} placeholder="例如：小陈" disabled={!canEdit}
          value={drafts.preferred_name} onChange={(event) => setDrafts((current) => ({ ...current, preferred_name: event.target.value }))} />)}
        {row("response_language", "回复语言", <select id="preference-response_language" disabled={!canEdit} value={drafts.response_language}
          onChange={(event) => setDrafts((current) => ({ ...current, response_language: event.target.value }))}>
          <option value="">未设置（默认中文）</option><option value="zh-CN">中文</option><option value="en">English</option>
        </select>)}
        {row("response_detail", "说明详略", <select id="preference-response_detail" disabled={!canEdit} value={drafts.response_detail}
          onChange={(event) => setDrafts((current) => ({ ...current, response_detail: event.target.value }))}>
          <option value="">未设置（标准）</option><option value="brief">简短</option><option value="standard">标准</option><option value="detailed">详细</option>
        </select>)}
      </div>}
      <div className={styles.preferenceFooter}>
        <button type="button" className={styles.secondary} disabled={loading || busy} onClick={() => { setNotice(""); void reload(); }}><RefreshCw size={16} />重新读取</button>
        <button type="button" className={styles.danger} disabled={loading || busy || state.retainedCount === 0} onClick={clear}>清空全部偏好</button>
      </div>
      <p className={styles.hint}>关闭记忆会停止读取，清空会删除当前范围内的偏好。清空不等于删除既有聊天记录或备份。</p>
    </>}
  </section>;
}
