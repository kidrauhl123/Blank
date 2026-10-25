"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { bankRequest, BankRequestError, jsonPost } from "@/lib/client-request";
import type { ScheduleData } from "@/lib/scheduled-task-types";
import { BankDialog } from "./BankDialog";
import { DailyReviewProgress } from "./DailyReviewProgress";
import styles from "./ProactiveAttention.module.css";

export function ProactiveAttention() {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const request = useRef<{ scheduleId: string; requestKey: string } | null>(null);
  const working = useRef(false);
  const live = useRef(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/schedules", { cache: "no-store" });
    if (!response.ok) throw new Error("主动关注暂时无法读取。");
    const result: ScheduleData = await response.json();
    if (!Array.isArray(result.runs) || !Array.isArray(result.tasks)) throw new Error("主动关注暂时无法读取。");
    if (live.current) { setData(result); setError(""); }
  }, []);
  useEffect(() => {
    live.current = true;
    const refresh = () => { if (document.visibilityState === "visible") void load().catch(reason => { if (live.current) setError(reason instanceof Error ? reason.message : "暂时无法读取。"); }); };
    const first = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => { live.current = false; window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);
  const runs = (data?.runs ?? []).filter(run => run.ai);
  const pending = runs.find(run => ["PENDING", "RUNNING"].includes(run.status));
  const latest = pending ?? runs[0];
  const task = data?.tasks.find(task => task.kind === "DAILY_AI_REVIEW" && task.status === "ACTIVE");
  const detail = runs.find(run => run.id === detailId);
  const configured = data?.dailyReview?.jev.configured && data.dailyReview.mainModel.configured;
  async function runNow() {
    if (!task || working.current || !configured || pending) return;
    working.current = true; setBusy(true); setError("");
    request.current ??= { scheduleId: task.id, requestKey: crypto.randomUUID() };
    try {
      const result = await bankRequest<{ runId: string }>("/api/v1/schedules/review-now", jsonPost(request.current));
      request.current = null;
      if (!live.current) return;
      await load(); setDetailId(result.runId);
    } catch (reason) {
      if (reason instanceof BankRequestError && !reason.outcomeUnknown) request.current = null;
      if (live.current) setError(reason instanceof Error ? reason.message : "暂时无法确认检查状态，请刷新后核对。");
    } finally { working.current = false; if (live.current) setBusy(false); }
  }
  return <section className={styles.card} aria-label="AI 主动关注" data-proactive-attention data-proactive-run-id={latest?.id}>
    <div className={styles.heading}><h2>AI 主动关注</h2><span>{pending ? "正在检查" : latest?.status === "SKIPPED" ? "本轮无新事项" : latest?.status === "SUCCEEDED" ? "有新的检查结果" : "每日账户巡检"}</span></div>
    {latest ? <><p className={styles.summary}>{latest.summary.split("\n")[0]}</p><button data-agent-id="view-proactive-result" data-agent-permission="navigate" onClick={() => setDetailId(latest.id)}>查看检查过程与结果</button></> : <p className={styles.muted}>{data ? "开启后会在这里显示主动检查的结果。" : "正在读取巡检状态…"}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {task ? <>
      <p className={styles.muted}>下次自动检查：{new Date(task.next_run_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</p>
      {!data?.scheduler.running && <p className={styles.muted}>后台调度暂未就绪。</p>}
      {!configured && <p className={styles.muted}>分析服务尚未配置完成。</p>}
      <div className={styles.actions}><button data-agent-id="run-proactive-review" data-agent-permission="human" disabled={busy || !!pending || !configured || !data?.scheduler.running} onClick={() => void runNow()}>{busy ? "正在提交…" : pending ? "等待本轮检查完成" : "立即检查一次"}</button><Link href="/schedules">调整安排</Link></div>
    </> : <Link className={styles.setup} href="/schedules">设置每日巡检</Link>}
    {detail && <BankDialog title="账户巡检" eyebrow="AI 主动关注" close={() => setDetailId(null)}><DailyReviewProgress run={detail} /></BankDialog>}
  </section>;
}
