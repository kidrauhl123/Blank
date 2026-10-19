import { AlertCircle, Check, Clock3, LoaderCircle, Pause, Square } from "lucide-react";
import type { TimelineEvent, TimelineState } from "./timeline";
import styles from "./VoiceTraceDemo.module.css";

const labels: Record<TimelineState, string> = {
  running: "进行中", done: "已完成", waiting: "等待你", paused: "已暂停",
  blocked: "已阻止", failed: "失败", cancelled: "已结束",
};

function StateIcon({ state }: { state: TimelineState }) {
  if (state === "done") return <Check size={16} aria-hidden="true" />;
  if (state === "running") return <LoaderCircle size={16} aria-hidden="true" />;
  if (state === "waiting") return <Clock3 size={16} aria-hidden="true" />;
  if (state === "paused") return <Pause size={16} aria-hidden="true" />;
  if (state === "cancelled") return <Square size={15} aria-hidden="true" />;
  return <AlertCircle size={16} aria-hidden="true" />;
}

export function TaskTimeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <p className={styles.empty}>开始一项任务后，这里会显示每一步。</p>;
  const completed = events.filter((event) => event.state === "done").length;
  return <section className={styles.timeline} aria-label="Agent 执行时间线">
    <div className={styles.timelineHead}><strong>执行过程</strong><span>{completed} 步已完成</span></div>
    <ol>{events.map((event) => <li key={event.id} className={styles.event} data-state={event.state}>
      <span className={styles.eventIcon}><StateIcon state={event.state} /></span>
      <div className={styles.eventBody}>
        <div className={styles.eventTop}><strong>{event.title}</strong><span>{labels[event.state]}</span></div>
        {event.detail && <p>{event.detail}</p>}
        <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      </div>
    </li>)}</ol>
  </section>;
}
