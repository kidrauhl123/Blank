"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { bankRequest, jsonPost } from "@/lib/client-request";
import type { ScheduleData } from "@/lib/scheduled-task-types";
import { DailyReviewProgress } from "./DailyReviewProgress";
import styles from "./ScheduledTasks.module.css";

type Data = ScheduleData;
type Identity = { id: string; channelType: "QQ" | "WECOM"; status: string };
const statusNames: Record<string, string> = { ACTIVE: "执行中", PAUSED: "已暂停", CANCELLED: "已取消", COMPLETED: "已结束", ERROR: "需处理" };
const frequencyNames: Record<string, string> = { ONCE: "仅一次", DAILY: "每天", WEEKLY: "每周", MONTHLY: "每月" };
const runStatusNames: Record<string, string> = { PENDING: "等待执行", RUNNING: "正在检查", SUCCEEDED: "已完成", SKIPPED: "无需进一步分析", FAILED: "执行失败", CANCELLED: "已停止" };
function date(value: string) { return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); }
function toISO(local: string) { return new Date(`${local}:00+08:00`).toISOString(); }

export function ScheduledTasks() {
  const [data, setData] = useState<Data | null>(null);
  const [channels, setChannels] = useState<Identity[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("REMINDER");
  const [frequency, setFrequency] = useState("ONCE");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const pending = useRef(false);
  const requestKey = useRef<string | null>(null);
  const pendingBody = useRef<Record<string, unknown> | null>(null);
  const [uncertain, setUncertain] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/schedules", { cache: "no-store" });
    if (response.status === 401 || response.status === 403) { setSignedOut(true); setData(null); return; }
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "暂时无法读取任务。");
    setSignedOut(false); setData(result);
    const bindingResponse = await fetch("/api/v1/channels", { cache: "no-store" });
    if (bindingResponse.ok) setChannels((await bindingResponse.json()).channels.filter((item: Identity) => item.status === "ACTIVE"));
  }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load().catch(() => setError("暂时无法读取任务，请稍后刷新。")); };
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (!pendingBody.current) {
        requestKey.current ??= crypto.randomUUID();
        pendingBody.current = {
          requestKey: requestKey.current, kind, title: fields.get("title"), message: fields.get("message") ?? "", frequency,
          timezone: "Asia/Shanghai", startsAt: toISO(String(fields.get("startsAt"))),
          endsAt: fields.get("endsAt") ? toISO(String(fields.get("endsAt"))) : null,
          channelIdentityId: fields.get("channelIdentityId") || null, confirmed: fields.get("confirmed") === "on",
        };
      }
      await bankRequest("/api/v1/schedules", jsonPost(pendingBody.current));
      pendingBody.current = null; requestKey.current = null; setUncertain(false);
      form.reset(); setKind("REMINDER"); setFrequency("ONCE"); setNotice("任务已保存，可在下方查看下次执行时间。");
      await load();
    } catch (failure) {
      // Preserve the exact request and idempotency key after an ambiguous result.
      const unknown = !(failure && typeof failure === "object" && "outcomeUnknown" in failure) || !!failure.outcomeUnknown;
      setUncertain(unknown && !!pendingBody.current);
      if (!unknown) { pendingBody.current = null; requestKey.current = null; }
      setError(failure instanceof Error ? failure.message : "结果暂时无法确认。请核对任务列表，或重试原请求。");
    } finally { pending.current = false; setBusy(false); }
  }
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
    <p className={styles.muted}>提醒、账单、订阅与每日 AI 巡检。时间均为北京时间。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {signedOut ? <p>请先<Link href="/">返回银行选择用户</Link>。</p> : !data ? <p>正在读取任务…</p> : <>
      {!data.scheduler.running && <p className={styles.warning} role="status">后台调度暂未就绪，任务可保存，按时执行需等待服务恢复。{data.scheduler.lastTickAt && `最近在线：${date(data.scheduler.lastTickAt)}`}</p>}
      <section><h2>新建任务</h2>
        <form onSubmit={create}>
          <fieldset disabled={busy || uncertain}>
            <label>任务类型<select value={kind} onChange={event => { setKind(event.target.value); if (event.target.value === "MONTHLY_REPORT") setFrequency("MONTHLY"); if (event.target.value === "DAILY_AI_REVIEW") setFrequency("DAILY"); }}><option value="REMINDER">自定义提醒</option><option value="MONTHLY_REPORT">月度账单报告</option><option value="SUBSCRIPTION_CHECK">订阅到期检查</option><option value="DAILY_AI_REVIEW">每日 AI 巡检</option></select></label>
            <label>任务名称<input name="title" required maxLength={80} placeholder="例如：每月账单回顾" /></label>
            {kind === "REMINDER" && <label>提醒内容<textarea name="message" required maxLength={500} rows={3} /></label>}
            {kind === "MONTHLY_REPORT" && <p className={styles.muted}>生成执行日期前一个自然月的账面收支报告，包含转账等资金往来。</p>}
            {kind === "SUBSCRIPTION_CHECK" && <p className={styles.muted}>检查已保存订阅中未来 72 小时的到期记录；没有到期记录时仅保存检查结果。</p>}
            {kind === "DAILY_AI_REVIEW" && <>
              <p className={styles.muted}>每日检查账户、近期提醒、订阅与模拟持仓，先判断是否需要进一步分析。有新关注事项时才通知，仅提供检查结果。</p>
              <label>关注事项（选填）<textarea name="message" maxLength={500} rows={3} placeholder="例如：关注近期提醒和订阅扣费准备" /></label>
              {data.dailyReview && (!data.dailyReview.jev.configured || !data.dailyReview.mainModel.configured) && <p className={styles.warning}>分析服务尚未配置齐全，任务可保存，执行需等待配置完成。</p>}
              <p className={styles.muted}>使用当前共享模拟账户的数据与已保存提醒，不读取浏览器私有记忆；本任务不预留资金或下单。</p>
            </>}
            <div className={styles.row}><label>执行频率<select value={frequency} onChange={event => setFrequency(event.target.value)} disabled={kind === "MONTHLY_REPORT" || kind === "DAILY_AI_REVIEW"}>{Object.entries(frequencyNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>首次执行时间<input type="datetime-local" name="startsAt" required /></label></div>
            <p className={styles.muted}>按月执行沿用首次日期，遇到短月在月末执行。服务恢复后补跑一次，暂停期间的周期不补跑。</p>
            <label>截止时间（选填）<input type="datetime-local" name="endsAt" /></label>
            <label>通知方式<select name="channelIdentityId"><option value="">仅在 APP 查看结果</option>{channels.map((channel, index) => <option key={channel.id} value={channel.id}>APP + {channel.channelType === "QQ" ? "QQ" : "企业微信"}{channels.filter(item => item.channelType === channel.channelType).length > 1 ? `（绑定 ${index + 1}）` : ""}</option>)}</select></label>
            <p className={styles.muted}>聊天通知只提示有新结果，详情保留在 APP。送达受渠道连接与平台规则影响。</p>
            <label className={styles.check}><input type="checkbox" name="confirmed" required />确认按以上时间执行，并使用所选通知方式</label>
          </fieldset>
          <button className={styles.primary} disabled={busy} type="submit">{busy ? "正在保存…" : uncertain ? "重试原请求并核对结果" : "确认创建"}</button>
        </form>
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
