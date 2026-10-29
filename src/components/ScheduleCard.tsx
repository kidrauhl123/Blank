"use client";

import { useEffect, useState } from "react";
import type { ScheduleCardView } from "@/lib/schedule-chat";
import { AssistantMark } from "./AssistantMark";
import styles from "./FeedPanel.module.css";

const STATUS: Record<ScheduleCardView["status"], string> = { DRAFT: "预览 · 选“创建任务”后生效", ACTIVE: "已创建，按时执行", PAUSED: "已暂停", ERROR: "需要处理，见「定时任务」页" };

// 对话里展示的定时任务卡片：每次出现都重新读取，创建后会显示“已创建”。
export function ScheduleCardById({ id }: { id: string }) {
  const [card, setCard] = useState<ScheduleCardView | "missing" | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/schedules/drafts/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async response => { const result = await response.json().catch(() => null); if (alive) setCard(response.ok && result?.card ? result.card : "missing"); })
      .catch(() => { if (alive) setCard("missing"); });
    return () => { alive = false; };
  }, [id]);
  if (card === null) return <p className={styles.empty} aria-busy="true">正在生成任务预览…</p>;
  if (card === "missing") return <p className={styles.empty}>这个任务已结束或暂时无法读取。</p>;
  return <article className={`${styles.post} ${styles.previewCard}`} aria-label={`任务预览：${card.title}`}>
    <span className={styles.mine}>{card.kind}</span>
    <h3>{card.title}</h3>
    <div className={styles.recipe}>
      <div className={styles.stat}><small>什么时候</small><b className={styles.statSmall}>{card.rhythm}</b></div>
      <div className={styles.stat}><small>{card.status === "DRAFT" ? "第一次" : "下一次"}</small><b className={styles.statSmall}>{card.nextRun}</b></div>
      {card.message && <p className={styles.note}>{card.message}</p>}
      <p className={styles.note}>现在做一次大概是这样：{card.sample}</p>
    </div>
    <p className={styles.body}>{card.delivery}</p>
    <footer><span className={styles.byline}><AssistantMark size={14} />{STATUS[card.status]}</span></footer>
  </article>;
}
