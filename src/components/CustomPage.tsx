"use client";

import { useEffect, useState } from "react";
import type { PageView } from "@/lib/ui-store";
import { RecipeBlocks } from "./FeedPanel";
import styles from "./CustomPage.module.css";

// 用户自己长出来的页面：服务端按账本算好每个面板的积木，这里只负责按排版语法摆放（半宽成对、其余整行）。
export function PagePanels({ page }: { page: Pick<PageView, "panels"> }) {
  return <div className={styles.panels}>{page.panels.map(panel => <section key={panel.title} className={styles.panel} data-width={panel.width} aria-label={panel.title}>
    <h2>{panel.title}</h2>
    <RecipeBlocks blocks={panel.blocks} />
  </section>)}</div>;
}

export function CustomPage({ pageId, refresh = 0 }: { pageId: string; refresh?: number }) {
  const [state, setState] = useState<PageView | "missing" | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/ui/pages/${encodeURIComponent(pageId)}`, { cache: "no-store" })
      .then(async response => { const result = await response.json().catch(() => null); if (alive) setState(response.ok && result?.page ? result.page : "missing"); })
      .catch(() => { if (alive) setState("missing"); });
    return () => { alive = false; };
  }, [pageId, refresh]);
  if (state === null) return <div className={styles.page}><p className={styles.empty} aria-busy="true">正在读取页面…</p></div>;
  if (state === "missing") return <div className={styles.page}><p className={styles.empty}>这个页面已经删除或暂时无法读取。</p></div>;
  return <div className={styles.page}>
    <div className={styles.head}><h1>{state.name}</h1><span>由你和 Blank 一起设计 · 数字来自账本</span></div>
    <PagePanels page={state} />
  </div>;
}
