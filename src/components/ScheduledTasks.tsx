"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { bankRequest, jsonPost } from "@/lib/client-request";
import type { ScheduleData } from "@/lib/scheduled-task-types";
import { DailyReviewProgress } from "./DailyReviewProgress";
import styles from "./ScheduledTasks.module.css";

type Data = ScheduleData;
const statusNames: Record<string, string> = { ACTIVE: "执行中", PAUSED: "已暂停", CANCELLED: "已取消", COMPLETED: "已结束", ERROR: "需处理" };
const frequencyNames: Record<string, string> = { ONCE: "仅一次", DAILY: "每天", WEEKLY: "每周", MONTHLY: "每月" };
const runStatusNames: Record<string, string> = { PENDING: "等待执行", RUNNING: "正在检查", SUCCEEDED: "已完成", SKIPPED: "无需进一步分析", FAILED: "执行失败", CANCELLED: "已停止" };
function date(value: string) { return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); }

export function ScheduledTasks() {
  const [data, setData] = useState<Data | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const pending = useRef(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/schedules", { cache: "no-store" });
    if (response.status === 401 || response.status === 403) { setSignedOut(true); setData(null); return; }
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "暂时无法读取任务。");
    setSignedOut(false); setData(result);
  }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load().catch(() => setError("暂时无法读取任务，请稍后刷新。")); };
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  async function change(id: string, action: "pause" | "resume" | "cancel") {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await bankRequest("/api/v1/schedules", { ...jsonPost({ id, action }), method: "PATCH" });
      setCancelId(null); setNotice(action === "cancel" ? "已取消后续执行，已生成的结果和通知会保留。" : action === "pause" ? "任务已暂停。" : "任务已恢复。");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "暂时无法确认，请刷新任务状态。"); }
    finally { pending.current = false; setBusy(false); }
  }

  return <main className={styles.page}>
    <header><Link href="/">← 返回银行</Link><button disabled={busy} onClick={() => void load().then(() => setError("")).catch(() => setError("刷新失败，请稍后重试。"))}>刷新</button></header>
    <h1>定时任务</h1>
    <p className={styles.muted}>你的提醒、账单、订阅检查与每日巡检。时间均为北京时间；结果也会发到首页动态里。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {signedOut ? <p>请先<Link href="/">返回银行选择用户</Link>。</p> : !data ? <p>正在读取任务…</p> : <>
      {!data.scheduler.running && <p className={styles.warning} role="status">后台调度暂未就绪，任务可保存，按时执行需等待服务恢复。{data.scheduler.lastTickAt && `最近在线：${date(data.scheduler.lastTickAt)}`}</p>}
      <section><h2>新建任务</h2>
        <p className={styles.muted}>任务由你和 Blank 在对话里一起设计：先给你看预览，你说“好”才生效。回到 Blank，试试这样说：</p>
        <ul className={styles.examples}>
          <li>每月 5 号早上 9 点提醒我还信用卡</li>
          <li>每月 1 号给我一份上个月的账单</li>
          <li>订阅要扣费前提前告诉我</li>
          <li>每天帮我看看账户有没有需要留意的变化</li>
        </ul>
        <Link href="/" className={styles.primary}>去和 Blank 说</Link>
      </section>
      <section><h2>我的任务</h2>{!data.tasks.length && <p className={styles.muted}>还没有任务。</p>}
        {data.tasks.map(task => <article className={styles.item} key={task.id}>
          <div className={styles.row}><b>{task.title}</b><span>{statusNames[task.status]}</span></div>
          <p className={styles.muted}>{frequencyNames[task.frequency]}{task.status === "ACTIVE" ? ` · ${task.retry_at ? "重试" : "下次执行"} ${date(task.retry_at ?? task.next_run_at)}` : ""}</p>
          {["ACTIVE", "PAUSED", "ERROR"].includes(task.status) && <div className={styles.actions}>
            <button disabled={busy} onClick={() => void change(task.id, task.status === "ACTIVE" ? "pause" : "resume")}>{task.status === "ACTIVE" ? "暂停" : "恢复"}</button>
            {cancelId === task.id ? <><span>取消后不再执行？</span><button disabled={busy} onClick={() => void change(task.id, "cancel")}>确认取消</button><button disabled={busy} onClick={() => setCancelId(null)}>保留</button></> : <button disabled={busy} onClick={() => setCancelId(task.id)}>取消任务</button>}
          </div>}
        </article>)}
      </section>
      <section><h2>最近执行结果</h2><p className={styles.muted}>最近 50 条；任务列表优先显示未结束任务，最多 200 个。</p>{!data.runs.length && <p className={styles.muted}>任务执行后，结果会显示在这里。</p>}
        {data.runs.map(run => <article className={styles.item} key={run.id}><div className={styles.row}><b>{run.title}</b><span>{runStatusNames[run.status] ?? run.status}</span></div>{!run.ai && <p className={styles.result}>{run.summary}</p>}
          {run.ai && <DailyReviewProgress run={run} />}
          <small className={styles.muted}>{date(run.completed_at)}{run.delivery ? ` · 通知${run.delivery.status === "SENT" ? "已发送" : run.delivery.attempts >= 8 ? "发送失败" : run.delivery.status === "FAILED" ? "等待重试" : "等待发送"}` : " · APP 内查看"}</small></article>)}
      </section>
    </>}
  </main>;
}
