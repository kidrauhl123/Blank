"use client";

import { useEffect, useState } from "react";
import { bankRequest, jsonPost } from "@/lib/client-request";
import type { ToolView } from "@/lib/tool-spec";
import { AssistantMark } from "./AssistantMark";
import { SliderSimulator } from "./SliderSimulator";
import { SplitTable } from "./SplitTable";
import styles from "./ToolCard.module.css";

const KIND = { "slider-simulator": "滑块模拟器", "split-table": "分账表" } as const;

// 对话里的 [[tool:编号]] 和首页的“小工具”区块共用。每次出现都重新读取，保存或移除后刷新外壳上的状态。
export function ToolCardById({ id }: { id: string }) {
  const [view, setView] = useState<ToolView | "missing" | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/tools/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async response => { const result = await response.json().catch(() => null); if (alive) setView(response.ok && result?.tool ? result.tool : "missing"); })
      .catch(() => { if (alive) setView("missing"); });
    return () => { alive = false; };
  }, [id, version]);

  if (view === null) return <p className={styles.empty} aria-busy="true">正在算这个小工具…</p>;
  if (view === "missing") return <p className={styles.empty}>这个小工具已经失效或暂时无法读取。</p>;

  const toggleSaved = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await bankRequest(`/api/v1/tools/${encodeURIComponent(id)}`, jsonPost({ action: view.saved ? "unsave" : "save" }));
      // 首页会重新读取布局；这里再取一次卡片，按钮文字跟着变。
      window.dispatchEvent(new Event("blank:ui-changed"));
      setVersion(current => current + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法完成，请稍后再试。"); }
    finally { setBusy(false); }
  };

  return <article className={styles.card} aria-label={`小工具：${view.spec.title}`} data-saved={view.saved || undefined}>
    <header><span className={styles.kind}>{KIND[view.kind]}</span><span className={styles.status}>{view.saved ? "已放在首页" : ""}</span></header>
    <h3 className={styles.title}>{view.spec.title}</h3>
    {view.kind === "slider-simulator"
      ? <SliderSimulator spec={view.spec} monthlyNetMinor={view.base.monthlyNetMinor} />
      : <SplitTable id={id} spec={view.spec} rows={view.rows} receivedMinor={view.receivedMinor} friendFound={view.friendFound} />}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <footer className={styles.footer}>
      <span className={styles.byline}><AssistantMark size={14} />Blank 帮你当场做的 · 数字由公式算出</span>
      <span className={styles.actions}><button type="button" disabled={busy} onClick={() => void toggleSaved()}>{view.saved ? "从首页移除" : "保存到首页"}</button></span>
    </footer>
  </article>;
}
