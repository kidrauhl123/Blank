"use client";

import type { ScheduleRunView } from "@/lib/scheduled-task-types";
import styles from "./DailyReviewProgress.module.css";

const labels = { QUIET: "本轮无需深入分析", REVIEW: "本轮需要深入分析", UNCERTAIN: "判断不确定，交由主模型复核", REQUIRED: "已有需关注事项，继续分析" };
export function DailyReviewProgress({ run }: { run: ScheduleRunView }) {
  const ai = run.ai;
  if (!ai) return null;
  const complete = ai.status === "DONE";
  const stopped = ["ERROR", "CANCELLED"].includes(ai.status);
  const step = ai.result || ai.gate?.decision === "QUIET" ? 3 : ai.gate || ai.mainRequestedAt ? 2 : ai.capturedAt ? 1 : 0;
  const stages = [
    ["读取账户与提醒", !!ai.capturedAt, false],
    ["Jev 判断是否需要分析", !!ai.gate, false],
    ["主模型整理关注事项", !!ai.result?.mainModel, ai.gate?.decision === "QUIET"],
    ["保存检查结果", complete, false],
  ] as const;
  return <div className={styles.content} data-review-run-id={run.id} data-review-status={run.status}>
    <p className={styles.meta}>{run.trigger_source === "MANUAL" ? "本次由用户手动触发" : "本次由后台定时触发"}</p>
    <ol className={styles.stages}>{stages.map(([label, done, skipped], index) => {
      const state = skipped ? ai.mainRequestedAt ? "本次不再请求" : "本轮跳过" : done ? "已完成" : stopped && index === step ? "已停止" : !stopped && index === step && run.status === "RUNNING" ? "进行中" : "等待";
      return <li key={label}><span>{label}</span><small data-state={state}>{state}</small></li>;
    })}</ol>
    {ai.gate && <p className={styles.meta}>Jev · {ai.gate.model}<br />{labels[ai.gate.decision]} · 需要分析的概率 {(ai.gate.probability * 100).toFixed(1)}% · {ai.gate.latencyMs} ms</p>}
    <p className={styles.result}>{run.summary}</p>
    {ai.error && <small className={styles.meta}>服务状态：{ai.error}</small>}
    {ai.result?.mainModel && <small className={styles.meta}>分析模型：{ai.result.mainModel}</small>}
    {ai.facts?.length ? <details className={styles.evidence}><summary>查看本次检查的数据依据</summary>
      {ai.facts.map(fact => <p key={fact.id}>{fact.description}</p>)}
    </details> : null}
    {ai.capturedAt && <small className={styles.meta}>数据截至 {new Date(ai.capturedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</small>}
  </div>;
}
