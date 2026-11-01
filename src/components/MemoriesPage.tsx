"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { bankRequest } from "@/lib/client-request";
import styles from "./MemoriesPage.module.css";

type Memory = { id: string; kind: "event" | "preference"; text: string; dueOn: string | null; version: string };
const KIND_LABEL = { event: "生活事件", preference: "偏好" } as const;
const json = (method: "PATCH" | "DELETE", body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// “我记住的事”：用户看到 Blank 从对话里记下的生活事件和偏好，可以改、可以删。改和删都带着看到的版本号，旧版本不会覆盖新的修改。
export function MemoriesPage() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ text: "", dueOn: "" });
  const [busy, setBusy] = useState(false);

  // 挂载时读取一次：setState 只出现在异步回调里，卸载后不再更新（和 ToolCard 一样）。
  useEffect(() => {
    let alive = true;
    bankRequest<{ memories: Memory[] }>("/api/v1/memories", { cache: "no-store" })
      .then(result => { if (alive) setMemories(result.memories); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "暂时无法读取。"); });
    return () => { alive = false; };
  }, []);
  const reload = () => bankRequest<{ memories: Memory[] }>("/api/v1/memories", { cache: "no-store" })
    .then(result => setMemories(result.memories))
    .catch(() => undefined);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setEditing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时无法完成，请稍后再试。");
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const save = (memory: Memory) => run(() => bankRequest(`/api/v1/memories/${encodeURIComponent(memory.id)}`,
    json("PATCH", { version: memory.version, text: draft.text, ...(memory.kind === "event" ? { dueOn: draft.dueOn || null } : {}) })));
  const remove = (memory: Memory) => run(() => bankRequest(`/api/v1/memories/${encodeURIComponent(memory.id)}`, json("DELETE", { version: memory.version })));

  return <main className={styles.page}>
    <header><Link href="/">← 返回</Link></header>
    <h1>我记住的事</h1>
    <p className={styles.muted}>这些是你在对话里亲口说过的事。到期前 Blank 会在动态里提醒你，并注明“你说过”。你可以改，也可以删。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {memories === null ? <p className={styles.muted}>正在读取…</p>
      : !memories.length ? <p className={styles.muted}>还没有记住的事。可以对 Blank 说“下周五是我妈生日”或“我在戒奶茶”试试。</p>
        : <ul className={styles.list}>{memories.map(memory => <li key={memory.id}>
          <header><span className={styles.tag}>{KIND_LABEL[memory.kind]}</span>{memory.dueOn && <span className={styles.date}>{memory.dueOn}</span>}</header>
          {editing === memory.id ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(memory); }}>
            <input aria-label="内容" value={draft.text} maxLength={60} disabled={busy} onChange={event => setDraft(current => ({ ...current, text: event.target.value }))} />
            {memory.kind === "event" && <input aria-label="日期" type="date" value={draft.dueOn} disabled={busy} onChange={event => setDraft(current => ({ ...current, dueOn: event.target.value }))} />}
            <div className={styles.actions}>
              <button type="submit" className={styles.primary} disabled={busy}>保存</button>
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
            </div>
          </form>
            : <>
              <p>{memory.text}</p>
              <div className={styles.actions}>
                <button type="button" disabled={busy} onClick={() => { setEditing(memory.id); setDraft({ text: memory.text, dueOn: memory.dueOn ?? "" }); }}>修改</button>
                <button type="button" className={styles.delete} disabled={busy} onClick={() => void remove(memory)}>删除</button>
              </div>
            </>}
        </li>)}</ul>}
  </main>;
}
