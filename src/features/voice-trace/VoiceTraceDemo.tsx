"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import { TaskTimeline } from "./TaskTimeline";
import { VoiceComposer } from "./VoiceComposer";
import { mergeTimelineEvents, type TimelineEvent, type TimelineState } from "./timeline";
import styles from "./VoiceTraceDemo.module.css";

type DemoStatus = "idle" | "running" | "paused" | "waiting" | "finished" | "cancelled";
type DemoMode = "read" | "transfer";

export function VoiceTraceDemo() {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [status, setStatus] = useState<DemoStatus>("idle");
  const [reply, setReply] = useState("");
  const timer = useRef<number | null>(null);
  const phase = useRef(0);
  const mode = useRef<DemoMode>("read");
  const sequence = useRef(0);
  const runId = useRef("");

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const emit = (title: string, state: TimelineState, detail?: string) => {
    const next: TimelineEvent = { id: `${runId.current}:${++sequence.current}`, sequence: sequence.current, at: new Date().toISOString(), title, detail, state };
    setEvents((current) => mergeTimelineEvents(current, [next]));
  };
  const finishLatest = (nextState: TimelineState) => setEvents((current) => {
    const last = current.at(-1);
    if (!last) return current;
    return mergeTimelineEvents(current, [{ ...last, state: nextState }]);
  });
  const schedule = () => { timer.current = window.setTimeout(tick, 850); };
  const tick = () => {
    timer.current = null;
    if (phase.current === 0) {
      phase.current = 1;
      emit("理解需求", "running", "演示模式：只展示任务状态，不向模型或银行发送请求。");
      schedule();
    } else if (phase.current === 1) {
      finishLatest("done");
      phase.current = 2;
      emit("检查可执行步骤", "running", "核对当前任务需要哪些页面动作和人工确认。");
      schedule();
    } else if (phase.current === 2) {
      finishLatest("done");
      if (mode.current === "transfer") {
        phase.current = 4;
        emit("等待本人核对", "waiting", "转账场景必须由本人在真实银行页面核对金额、收款人并确认。样机不会执行交易。");
        setStatus("waiting");
        setReply("我已演示到需要本人核对的节点。这里没有连接银行账户，也没有发起转账。请以真实银行页面和回执为准。");
      } else {
        phase.current = 3;
        emit("生成说明", "running", "仅读取演示步骤，不读取真实余额或账单。");
        schedule();
      }
    } else if (phase.current === 3) {
      finishLatest("done");
      phase.current = 5;
      emit("演示流程结束", "done", "任务步骤已展示；没有读取真实账户数据。");
      setStatus("finished");
      setReply("演示流程已结束。这里没有连接银行账户，因此不能提供真实余额、账单或交易结果。");
    }
  };

  const start = (text: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    runId.current = crypto.randomUUID();
    sequence.current = 0;
    phase.current = 0;
    mode.current = /转账|汇款|過數|过数/.test(text) ? "transfer" : "read";
    setEvents([]); setReply(""); setStatus("running");
    emit("收到演示请求", "done", mode.current === "transfer" ? "将展示转账准备与人工确认节点。" : "将展示只读任务的步骤。");
    schedule();
  };
  const pause = () => {
    if (status !== "running") return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    finishLatest("paused");
    setStatus("paused");
  };
  const resume = () => { if (status !== "paused") return; finishLatest("running"); setStatus("running"); schedule(); };
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (status === "running" || status === "paused") finishLatest("cancelled");
    emit("用户结束演示", "cancelled", "未提交任何银行操作。");
    setStatus("cancelled");
    setReply("演示已结束，没有提交银行操作。");
  };
  const handoff = () => {
    if (status !== "waiting") return;
    finishLatest("done");
    emit("演示流程结束", "done", "已交回用户；样机无法核实任何真实交易结果。");
    setStatus("finished");
    setReply("已交回你本人操作。这个样机没有调用银行接口，无法确认真实转账结果。");
  };

  return <main className={styles.page}>
    <header className={styles.hero}><span className={styles.kicker}>BANKPILOT · 独立功能样机</span><h1>让助手听得见，也看得清</h1><p>体验语音输入和任务进度。这里不连接银行账户，不调用真实 Agent，也不执行交易。</p></header>
    <div className={styles.grid}>
      <VoiceComposer onSubmit={start} reply={reply} disabled={status === "running" || status === "waiting"} />
      <div className={styles.taskCard}>
        <div className={styles.taskHeading}><div><h2>任务可视化</h2><p>状态由结构化事件驱动，不从聊天文字猜测。</p></div><span className={styles.status} data-status={status}>{status === "idle" ? "尚未开始" : status === "running" ? "进行中" : status === "paused" ? "已暂停" : status === "waiting" ? "等待你" : status === "finished" ? "已结束" : "已取消"}</span></div>
        <TaskTimeline events={events} />
        <div className={styles.actions}>
          {status === "running" && <button type="button" className={styles.secondary} onClick={pause}><Pause size={18} />暂停演示</button>}
          {status === "paused" && <button type="button" className={styles.primary} onClick={resume}><Play size={18} />继续演示</button>}
          {status === "waiting" && <button type="button" className={styles.primary} onClick={handoff}>我已了解，结束演示</button>}
          {["running", "paused", "waiting"].includes(status) && <button type="button" className={styles.secondary} onClick={cancel}><Square size={17} />结束</button>}
        </div>
      </div>
    </div>
    <p className={styles.footnote}>可试说或输入“查看本月账单”“帮我转账”。识别文本需手动核对并发送；涉及转账时，流程停在本人确认节点。</p>
  </main>;
}
