"use client";

import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { bankRequest, jsonPost } from "@/lib/client-request";
import type { ProposalView } from "@/lib/ui-store";
import { AssistantMark } from "./AssistantMark";
import { PagePanels } from "./CustomPage";
import { PageIconMark } from "./page-icons";
import styles from "./ProposalCard.module.css";

const STATUS = { PENDING: "等你决定", APPLIED: "已应用", DISMISSED: "已放弃" } as const;
const KIND = { layout: "界面方案", page: "新页面", "remove-page": "删除页面" } as const;
const APPLY_LABEL = { layout: "应用到我的 Blank", page: "添加这个页面", "remove-page": "删除这个页面" } as const;

// 对话里的界面变更提案：只有用户在这里点“应用”才会改变界面——模型没有任何工具能代点。
export function ProposalCardById({ id }: { id: string }) {
  const [view, setView] = useState<ProposalView | "missing" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => fetch(`/api/v1/ui/proposals/${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(async response => { const result = await response.json().catch(() => null); setView(response.ok && result?.proposal ? result.proposal : "missing"); })
    .catch(() => setView("missing"));
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (view === null) return <p className={styles.empty} aria-busy="true">正在生成方案预览…</p>;
  if (view === "missing") return <p className={styles.empty}>这个方案已经失效或暂时无法读取。</p>;
  const decide = async (action: "apply" | "dismiss") => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await bankRequest(`/api/v1/ui/proposals/${encodeURIComponent(id)}`, jsonPost({ action }));
      await load();
      if (action === "apply") window.dispatchEvent(new Event("blank:ui-changed"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法完成，请稍后再试。"); }
    finally { setBusy(false); }
  };
  return <article className={styles.card} aria-label={`${KIND[view.kind]}：${view.summary}`} data-status={view.status}>
    <header><span className={styles.kind}>{KIND[view.kind]}</span><span className={styles.status}>{STATUS[view.status]}</span></header>
    <h3>{view.summary}</h3>
    {view.layout && <div className={styles.layout}>
      {view.layout.changedHome && <section><h4>首页，从上到下</h4><ol>{view.layout.home.map((item, index) => <li key={index}><b>{item.label}</b><small>{item.detail}</small></li>)}</ol></section>}
      {view.layout.changedNav && <section><h4>底部导航</h4><ul className={styles.nav}>{view.layout.nav.map((item, index) => <li key={index} data-page={item.isPage || undefined}>{item.icon !== "system" && <PageIconMark icon={item.icon} size={16} />}{item.label}</li>)}</ul></section>}
      {!view.layout.changedHome && !view.layout.changedNav && <p className={styles.note}>和现在一样，没有变化。</p>}
    </div>}
    {view.page && <>
      <p className={styles.note}><PageIconMark icon={view.page.icon} size={16} /> 页面「{view.page.name}」· {view.page.navNote}</p>
      <div className={styles.preview}><PagePanels page={view.page} /></div>
    </>}
    {view.removing && <p className={styles.note}>会删除页面「{view.removing.name}」，并从底部导航里移除。</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <footer>
      <span className={styles.byline}><AssistantMark size={14} />{view.status === "PENDING" ? "点“应用”才会生效" : STATUS[view.status]}</span>
      {view.status === "PENDING" && <span className={styles.actions}>
        <button disabled={busy} onClick={() => void decide("dismiss")}><X size={16} />不要</button>
        <button className={styles.apply} disabled={busy} onClick={() => void decide("apply")}><Check size={16} />{APPLY_LABEL[view.kind]}</button>
      </span>}
    </footer>
  </article>;
}
