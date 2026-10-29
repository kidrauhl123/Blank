"use client";

import { ArrowLeft, Check, ChevronRight, CircleAlert, CircleHelp, Clock3, GitBranch, LoaderCircle, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import styles from "./AuditConsole.module.css";
import { bankRequest, BankRequestError } from "@/lib/client-request";

type Node = { key: string; tool: string; status: string; dependencies: string[]; output: Record<string, unknown> };
type Task = { id: string; user_utterance: string; intent: string; status: string; risk_level: "GREEN" | "YELLOW" | "RED"; plan: unknown[]; created_at: string; nodes: Node[]; runtime_status?: string; channel_type?: string; interrupt_kind?: string | null; graph_thread_id?: string };
type Event = { id: string; task_id?: string; operation_id?: string; event_type: string; actor_type: string; event_summary: string; evidence: Record<string, unknown>; created_at: string };
type Policy = { id: string; task_id: string; operation_id: string; base_level: string; final_level: string; matched_rules: string[]; evidence: Record<string, unknown>; created_at: string };
type ExternalAccessRecord = { id: string; tool_name: string; outcome: string; operation_id?: string; input_summary: Record<string, unknown>; created_at: string };
type ChannelEvent = { id: string; task_id?: string; channel_type: string; direction: string; event_type: string; outcome: string; created_at: string };
type ChannelIdentity = { id: string; channel_type: string; status: string; bound_at: string; last_seen_at: string };

function statusKind(status: string) {
  const value = status.toUpperCase();
  if (["SUCCEEDED", "COMPLETED", "DONE", "SENT", "SUCCESS", "OK", "APPLIED", "OBSERVED"].includes(value)) return "done";
  if (["FAILED", "ERROR", "BLOCKED", "DENIED"].includes(value)) return "failed";
  if (["RUNNING", "EXECUTING", "SENDING", "ACTION"].includes(value)) return "running";
  if (["INTERRUPTED", "AWAITING_AUTH", "PENDING", "CONSENT", "HANDOFF", "QUESTION", "PAUSED", "CANCELLED"].includes(value)) return "waiting";
  return "unknown";
}
function statusText(status: string) {
  const labels: Record<string, string> = { SUCCEEDED: "已完成", COMPLETED: "已完成", DONE: "已完成", SENT: "已发送", SUCCESS: "成功", OK: "成功", APPLIED: "已执行", OBSERVED: "已读取", FAILED: "失败", ERROR: "失败", BLOCKED: "已阻止", DENIED: "已拒绝", RUNNING: "处理中", EXECUTING: "执行中", SENDING: "发送中", ACTION: "执行中", INTERRUPTED: "等待确认", AWAITING_AUTH: "等待确认", PENDING: "待处理", CONSENT: "等待授权", HANDOFF: "等待本人操作", QUESTION: "等待补充信息", PAUSED: "已暂停", CANCELLED: "已取消" };
  return labels[status.toUpperCase()] ?? `未知状态（${status}）`;
}
function StatusIcon({ status }: { status: string }) {
  const kind = statusKind(status), props = { size: 17, "aria-label": statusText(status), "data-kind": kind };
  return kind === "done" ? <Check {...props} /> : kind === "failed" ? <XCircle {...props} /> : kind === "running" ? <LoaderCircle {...props} className={styles.spin} /> : kind === "waiting" ? <Clock3 {...props} /> : <CircleHelp {...props} />;
}

export function AuditConsole() {
  const [data, setData] = useState<{ tasks: Task[]; events: Event[]; policies: Policy[]; externalAccessHistory: ExternalAccessRecord[]; channelEvents: ChannelEvent[]; channels: ChannelIdentity[]; outbox: Array<{ status: string; count: number }> } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<{ status: string; database: string; agentRuntime?: string } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    const [records, readiness] = await Promise.allSettled([
      bankRequest<NonNullable<typeof data>>("/api/audit"),
      bankRequest<NonNullable<typeof health>>("/api/health"),
    ]);
    if (records.status === "fulfilled") {
      const value = records.value;
      setData(value); setSelected(current => value.tasks.some(item => item.id === current) ? current : value.tasks[0]?.id ?? null); setError("");
    } else {
      setData(null);
      setError(records.reason instanceof BankRequestError && records.reason.status === 401 ? "请先进入银行账户，再查看操作记录。" : "操作记录暂时无法读取，请重试。");
    }
    setHealth(readiness.status === "fulfilled" ? readiness.value : null);
    setLoading(false);
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const task = data?.tasks.find((item) => item.id === selected);
  const events = data?.events.filter((item) => !selected || item.task_id === selected || !item.task_id) ?? [];
  const policy = data?.policies.find((item) => item.task_id === selected);
  const channelEvents = data?.channelEvents.filter((item) => item.task_id === selected) ?? [];

  return <main className={styles.page}>
    <header className={styles.header}><Link href="/"><ArrowLeft size={18} />返回 Blank</Link><div><span>B</span><b>安全审计台</b></div><button disabled={loading} onClick={() => void load()}><RefreshCw size={16} />刷新</button></header>
    <section className={styles.hero}><div><p>只读安全审计</p><h1>每一步，都可解释。</h1><span>计划、权限、工具调用和账本结果，全程留痕。</span></div><div className={styles.health} role="status" data-state={loading ? "waiting" : !health ? "unknown" : health.database === "connected" && health.status === "ok" ? "done" : "failed"}><i /><span><b>{loading ? "正在读取服务状态…" : !health ? "服务状态读取失败" : health.database === "connected" && health.status === "ok" ? "账户服务可连接" : "账户服务需检查"}</b><small>{loading ? "请稍候" : health?.database === "connected" ? health.agentRuntime === "ready" ? "数据库已连接 · 任务存储就绪" : "数据库已连接 · 任务存储尚未就绪" : "未能确认服务可用，请重试"}</small></span></div></section>
    {error && <div className={styles.error} role="alert">{error}</div>}
    <div className={styles.grid}>
      <aside className={styles.tasks}><div className={styles.panelTitle}><span>最近 Agent 任务</span><small>{data ? data.tasks.length : "—"} 个任务</small></div>{!data && <p className={styles.empty}>{loading ? "正在读取任务…" : "任务信息暂不可用"}</p>}{data && !data.tasks.length && <p className={styles.empty}>还没有 Blank 任务。</p>}{data?.tasks.map((item) => <button className={selected === item.id ? styles.selected : ""} key={item.id} onClick={() => setSelected(item.id)}><span className={styles.level} data-level={item.risk_level} /><span><b>{item.user_utterance}</b><small>{item.intent} · {new Date(item.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></span><ChevronRight size={15} /></button>)}</aside>
      <section className={styles.detail}>
        {!data ? <p className={styles.empty}>{loading ? "正在读取操作记录…" : "无法展示操作记录，请重新读取。"}</p> : task ? <>
          <div className={styles.detailHead}><div><span className={styles.badge} data-level={task.risk_level}>{task.risk_level}</span><h2>{task.user_utterance}</h2><p>Task ID · {task.id}{task.channel_type ? ` · ${task.channel_type}` : ""}{task.interrupt_kind ? ` · 等待 ${task.interrupt_kind}` : ""}</p></div><strong data-kind={statusKind(task.runtime_status ?? task.status)}>{statusText(task.runtime_status ?? task.status)}</strong></div>
          <div className={styles.subhead}><GitBranch size={17} /><b>执行步骤</b><span>{task.nodes.length} 个记录节点</span></div>
          <div className={styles.dag}>{task.nodes.length ? task.nodes.map((node, index) => <div className={styles.node} key={node.key}><div className={styles.nodeIndex}>{index + 1}</div><div><b>{node.key}</b><code>{node.tool}</code><small data-kind={statusKind(node.status)}>{statusText(node.status)}</small></div><span>{node.dependencies.length ? `依赖 ${node.dependencies.join(", ")}` : "入口节点"}</span><StatusIcon status={node.status} /></div>) : <p className={styles.empty}>任务尚未执行工具节点</p>}</div>
          {policy && <section className={styles.policy}><div className={styles.subhead}><ShieldCheck size={17} /><b>权限策略裁决</b></div><div className={styles.policyRoute}><span data-level={policy.base_level}>{policy.base_level}</span><i /><span data-level={policy.final_level}>{policy.final_level}</span><strong>{policy.final_level === "RED" ? "动态码强验证" : policy.final_level === "YELLOW" ? "用户明确确认" : policy.final_level === "GREEN" ? "自动查询" : "未识别的权限策略"}</strong></div><ul>{policy.matched_rules.map((rule) => <li key={rule}><Check size={13} />{rule}</li>)}</ul></section>}
          {channelEvents.length > 0 && <><div className={styles.subhead}><GitBranch size={17} /><b>渠道事件</b><span>{channelEvents.length} 条</span></div><div className={styles.dag}>{channelEvents.map((event) => <div className={styles.node} key={event.id}><div className={styles.nodeIndex}><Image src={event.channel_type === "QQ" ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={18} height={18} /></div><div><b>{event.event_type}</b><code>{event.direction} · {event.outcome}</code></div><span>{new Date(event.created_at).toLocaleTimeString("zh-CN")}</span><StatusIcon status={event.outcome} /></div>)}</div></>}
          <div className={styles.subhead}><CircleAlert size={17} /><b>操作事件</b><span>{events.length} 条</span></div>
          <div className={styles.timeline}>{events.map((event) => <article key={event.id}><time>{new Date(event.created_at).toLocaleTimeString("zh-CN")}</time><i /><div><b>{event.event_summary}</b><span>{event.actor_type} · {event.event_type}</span>{event.operation_id && <code>{event.operation_id}</code>}</div></article>)}</div>
        </> : <><div className={styles.detailHead}><div><span className={styles.badge} data-level="GREEN">CORE</span><h2>账户安全事件</h2><p>账户操作与身份验证的记录。</p></div></div><div className={styles.subhead}><CircleAlert size={17} /><b>事件流</b><span>{data?.events.length ?? 0} 条</span></div><div className={styles.timeline}>{data?.events.map((event) => <article key={event.id}><time>{new Date(event.created_at).toLocaleTimeString("zh-CN")}</time><i /><div><b>{event.event_summary}</b><span>{event.actor_type} · {event.event_type}</span>{event.operation_id && <code>{event.operation_id}</code>}</div></article>)}</div>{Boolean(data?.externalAccessHistory.length) && <><div className={styles.subhead}><GitBranch size={17} /><b>历史外部工具调用（已退役）</b><span>{data?.externalAccessHistory.length} 条</span></div><div className={styles.dag}>{data?.externalAccessHistory.map((call) => <div className={styles.node} key={call.id}><div className={styles.nodeIndex}>H</div><div><b>{call.tool_name}</b><code>{call.operation_id ?? call.outcome}</code></div><span>{new Date(call.created_at).toLocaleTimeString("zh-CN")}</span><StatusIcon status={call.outcome} /></div>)}</div></>}</>}
      </section>
    </div>
  </main>;
}
