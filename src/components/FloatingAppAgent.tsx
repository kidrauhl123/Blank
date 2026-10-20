"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Check, ChevronDown, Mic, Pause, Play, Send, Sparkles, Square, Volume2, X } from "lucide-react";
import { applyPageAction, captureAppPage, type PageMotion } from "@/lib/app-page";
import type { AppAgentView } from "@/lib/app-agent-protocol";
import { parsePreferenceCommand } from "@/lib/preference-command";
import { TaskTimeline } from "@/features/voice-trace/TaskTimeline";
import { useBrowserSpeech, type SpeechLanguage } from "@/features/voice-trace/useBrowserSpeech";
import styles from "./FloatingAppAgent.module.css";

type Message = { role: "user" | "assistant"; text: string };
type StepState = "ready" | "running" | "done" | "paused" | "blocked" | "waiting" | "cancelled" | "failed";
type Step = { id: string; label: string; state: StepState };
export type AppAgentTransport = {
  request: (body: Record<string, unknown>) => Promise<AppAgentView>;
  restore: (id: string) => Promise<AppAgentView>;
  storageKey: string;
};
async function request(body: Record<string, unknown>): Promise<AppAgentView> {
  const response = await fetch("/api/agent/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "助手暂时不可用");
  return result;
}

const bankTransport: AppAgentTransport = { request, storageKey: "bankpilot-app-agent-run", restore: async (id) => {
  const response = await fetch(`/api/agent/app?id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error("APP_AGENT_NOT_FOUND");
  return response.json();
} };
const stepLabels: Record<StepState, string> = { ready: "待执行", running: "正在执行", done: "已完成", paused: "已暂停", blocked: "已阻止", waiting: "等待你", cancelled: "已结束", failed: "已中断" };

function StepList({ items, compact = false }: { items: Step[]; compact?: boolean }) {
  if (!items.length) return null;
  const visible = compact ? items.slice(-2) : items;
  return <div className={compact ? styles.stepTray : styles.stepHistory} aria-label="助手操作步骤">
    <div className={styles.stepHeading}><span>操作进度</span><small>已完成 {items.filter((item) => item.state === "done").length} 步</small></div>
    <ol>{visible.map((item) => <li key={item.id} data-state={item.state}>
      <span className={styles.stepMark}>{item.state === "done" ? <Check size={12} /> : item.state === "paused" ? <Pause size={11} /> : items.indexOf(item) + 1}</span>
      <span className={styles.stepLabel}>{item.label}</span><small>{stepLabels[item.state]}</small>
    </li>)}</ol>
  </div>;
}

export function FloatingAppAgent({ rootRef, configured, openSignal, closeSignal = 0, onOpenChange, transport = bankTransport }: { rootRef: RefObject<HTMLElement | null>; configured: boolean; openSignal: number; closeSignal?: number; onOpenChange?: (open: boolean) => void; transport?: AppAgentTransport }) {
  const [open, setOpen] = useState(false);
  const [observedCloseSignal, setObservedCloseSignal] = useState(closeSignal);
  if (observedCloseSignal !== closeSignal) { setObservedCloseSignal(closeSignal); setOpen(false); }
  const [input, setInput] = useState("");
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("zh-CN");
  // Voice results replace the whole input only when it is empty; otherwise they
  // append so dictated amounts never wipe what the user already typed.
  const applyTranscript = useCallback((text: string) => {
    setInput((current) => current.trim() ? `${current.trimEnd()} ${text}` : text);
  }, []);
  const speech = useBrowserSpeech(applyTranscript, speechLanguage);
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<AppAgentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pageName, setPageName] = useState("当前页面");
  const [motion, setMotion] = useState<PageMotion | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const storageKey = transport.storageKey;
  const viewRef = useRef<AppAgentView | null>(null);
  const control = useRef(false);
  const paused = useRef(false);
  const generation = useRef(0);
  const worker = useRef(false);
  const alive = useRef(true);
  const endRequested = useRef(false);
  const historyEnd = useRef<HTMLDivElement>(null);
  const answerInput = useRef<HTMLInputElement>(null);
  const markStep = useCallback((id: string, state: StepState) => {
    setSteps((items) => items.map((item) => item.id === id && !(state === "paused" && ["done", "blocked"].includes(item.state)) ? { ...item, state } : item));
  }, []);

  const receive = useCallback(async (next: AppAgentView, restoredFinished = false) => {
    if (!alive.current) return;
    sessionStorage.setItem(storageKey, next.id);
    if (endRequested.current && next.pending) {
      try { next = await transport.request({ command: "cancel", id: next.id }); } catch { next = { ...next, status: "CANCELLED", pending: null }; }
    }
    if (paused.current && next.pending && next.status !== "PAUSED") {
      try { next = await transport.request({ command: "pause", id: next.id }); } catch { next = { ...next, status: "PAUSED" }; }
    }
    if (!alive.current) return;
    viewRef.current = next;
    setRun(next);
    if (next.pending) {
      const pending = next.pending;
      const step: Step = { id: pending.id, label: pending.action.type === "question" ? pending.action.question : pending.action.description,
        state: next.status === "PAUSED" ? "paused" : ["QUESTION", "HANDOFF", "CONSENT"].includes(next.status) ? "waiting" : "ready" };
      setSteps((items) => items.some((item) => item.id === step.id) ? items.map((item) => item.id === step.id && !["done", "blocked"].includes(item.state) ? step : item) : [...items, step]);
    }
    if (next.status === "QUESTION" || next.status === "CONSENT") setOpen(true);
    // After a clarification during an approved task, reveal the live page
    // again so subsequent actions and the user's confirmation stay visible.
    if (["ACTION", "HANDOFF"].includes(next.status) && next.controlGranted && !paused.current) setOpen(false);
    if (!next.pending) {
      control.current = false;
      paused.current = false;
      setMotion(null);
      setOpen(true);
      // A run that just completed in this tab keeps its id so the timeline
      // survives a refresh; a finished run restored from a previous page was
      // already shown once and should not re-open the panel on every visit.
      if (!restoredFinished) sessionStorage.removeItem(storageKey);
    }
  }, [transport, storageKey]);

  const pause = useCallback(() => {
    if (!control.current) return;
    control.current = false; paused.current = true; generation.current++;
    setMotion(null);
    const current = viewRef.current;
    if (current) {
      const next = { ...current, status: "PAUSED" as const, message: "你已接管页面，助手已暂停。" };
      viewRef.current = next; setRun(next);
      if (current.pending) markStep(current.pending.id, "paused");
      // The client stops immediately, even while the model is still responding.
      void transport.request({ command: "pause", id: current.id }).catch(() => undefined);
    }
  }, [markStep, transport]);

  useEffect(() => {
    const lifecycleGeneration = generation;
    alive.current = true;
    const saved = sessionStorage.getItem(storageKey);
    if (saved) {
      void transport.restore(saved).then(async (restored) => {
        // Reload never silently restores control of the page.
        paused.current = Boolean(restored.pending);
        // A finished run restored from a previous page must not pop the panel
        // open on its own: the user navigated somewhere else on purpose. Its
        // timeline stays available behind the same bottom-nav entry.
        const finished = !restored.pending;
        await receive(restored, finished);
        if (finished) setOpen(false);
      }).catch(() => sessionStorage.removeItem(storageKey));
    }
    const intervene = (event: Event) => {
      if (!event.isTrusted || (event.target instanceof Element && event.target.closest("[data-agent-overlay]"))) return;
      pause();
    };
    const hidden = () => { if (document.hidden) pause(); };
    const events = ["pointerdown", "touchstart", "keydown", "beforeinput", "input", "change", "wheel", "popstate"];
    events.forEach((name) => window.addEventListener(name, intervene, { capture: true, passive: true }));
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false; control.current = false; lifecycleGeneration.current++;
      events.forEach((name) => window.removeEventListener(name, intervene, true));
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [pause, receive, transport, storageKey]);

  useEffect(() => { historyEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages, run?.message, open]);

  useEffect(() => {
    if (!run?.pending || run.status !== "ACTION" || !control.current || worker.current || !rootRef.current) return;
    const action = run.pending;
    const token = generation.current;
    worker.current = true; setBusy(true); setError("");
    markStep(action.id, "running");
    void (async () => {
      let observed = false;
      try {
        const result = await applyPageAction(rootRef.current!, action.action, () => control.current && generation.current === token && alive.current,
          { onMotion: (point) => { if (alive.current && (point === null || control.current && generation.current === token)) setMotion(point); } });
        observed = true;
        if (alive.current && control.current && generation.current === token) markStep(action.id, result.status === "BLOCKED" ? "blocked" : result.status === "USER_CHANGED" ? "paused" : "done");
        if (!control.current || generation.current !== token) return;
        await receive(await transport.request({ command: "advance", id: run.id, actionId: action.id, result }));
      } catch (reason) {
        pause();
        if (!observed) markStep(action.id, "failed");
        if (alive.current) setError(reason instanceof Error ? reason.message : "操作中断，请核对页面");
      } finally {
        worker.current = false;
        if (alive.current) setBusy(false);
      }
    })();
  }, [run, busy, rootRef, receive, pause, transport, markStep]);

  const send = async (text = input) => {
    const message = text.trim();
    const preferenceCommand = parsePreferenceCommand(message);
    if (!message || busy || speech.listening || !rootRef.current || (!configured && !preferenceCommand)) return;
    setInput(""); setError(""); setBusy(true);
    setMessages((items) => [...items, { role: "user", text: message }]);
    const current = viewRef.current;
    try {
      if (current?.pending?.action.type === "question" && !preferenceCommand) {
        paused.current = false;
        control.current = current.controlGranted;
        markStep(current.pending.id, "done");
        await receive(await transport.request({ command: "advance", id: current.id, actionId: current.pending.id,
          result: { status: "USER_ANSWERED", message, page: captureAppPage(rootRef.current) } }));
      } else {
        control.current = false; paused.current = false; endRequested.current = false; generation.current++;
        setSteps([]); setMotion(null);
        if (current?.pending) await transport.request({ command: "cancel", id: current.id });
        const page = captureAppPage(rootRef.current);
        setPageName(page.name);
        await receive(await transport.request({ command: "start", message, page }));
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "助手未能启动"); }
    finally { setBusy(false); }
  };
  const continueRun = async () => {
    const current = viewRef.current;
    if (!current?.pending || busy || !rootRef.current) return;
    setBusy(true); setError(""); paused.current = false;
    try {
      let next: AppAgentView;
      if (!current.controlGranted && current.status !== "HANDOFF") {
        next = await transport.request({ command: "allow", id: current.id });
      } else {
        markStep(current.pending.id, current.status === "HANDOFF" ? "done" : "cancelled");
        next = await transport.request({ command: "refresh", id: current.id, actionId: current.pending.id,
          result: { status: "USER_CHANGED", message: "用户请求继续，请按当前页面重新判断剩余任务，不重放旧动作。", page: captureAppPage(rootRef.current) } });
      }
      control.current = next.controlGranted;
      setOpen(false);
      await receive(next);
    } catch (reason) { control.current = false; paused.current = true; setError(reason instanceof Error ? reason.message : "暂时无法继续"); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    control.current = false; paused.current = false; endRequested.current = true; generation.current++;
    setMotion(null);
    setSteps((items) => items.map((item) => ["ready", "running", "waiting", "paused"].includes(item.state) ? { ...item, state: "cancelled" } : item));
    const current = viewRef.current;
    if (!current) return;
    try { await receive(await transport.request({ command: "cancel", id: current.id })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "结束失败，请稍后重试"); }
  };
  const expand = () => {
    if (control.current) pause();
    if (rootRef.current) setPageName(captureAppPage(rootRef.current).name);
    setOpen(true);
  };
  useEffect(() => {
    if (!openSignal) return;
    pause();
    if (rootRef.current) setPageName(captureAppPage(rootRef.current).name);
    setOpen(true);
  }, [openSignal, pause, rootRef]);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  const question = run?.pending?.action.type === "question" ? run.pending.action : null;
  const active = Boolean(run?.pending);
  const visibleSteps: Step[] = run?.timeline ? run.timeline.map((event) => ({ id: event.id, label: event.title, state: event.state })) : steps;
  const status = run?.status === "PAUSED" ? "你已接管 · 已暂停" : run?.status === "HANDOFF" ? "等待你确认或验证"
    : busy ? run?.message ?? "正在理解需求" : run?.message ?? "";

  return <div className={styles.root} data-agent-overlay>
    {/* 助手的手和用户的手是同一种形状：画布上的一个圆形触点。 */}
    {motion && <div className={styles.cursor} data-phase={motion.phase} style={{ left: motion.x, top: motion.y }} aria-hidden="true"><span>{motion.phase === "typing" ? "正在填写" : motion.phase === "clicking" ? "点击" : "BankPilot"}</span></div>}
    {!open && active && <StepList items={visibleSteps} compact />}
    {/* 只在 agent 真的有事要报告时出现；平时首页的 AI 入口是底部导航那一个 */}
    {!open && active && <div className={styles.floating}>
      <button className={styles.trigger} onClick={expand} aria-label="打开悬浮助手"><Sparkles size={18} /><span>{status}</span></button>
      {run?.status === "PAUSED" || run?.status === "HANDOFF" ? <button onClick={continueRun} disabled={busy} aria-label="继续代操作"><Play size={17} /></button> : run?.controlGranted && run.status === "ACTION" ? <button onClick={pause} aria-label="暂停代操作"><Pause size={17} /></button> : null}
      <button onClick={cancel} aria-label="结束代操作"><Square size={15} /></button>
    </div>}
    {open && <section className={styles.panel} role="dialog" aria-modal="false" aria-label="BankPilot 悬浮助手">
      <header><span><Sparkles size={19} /><b>BankPilot</b></span><button onClick={() => { speech.cancelListening(); if (speech.speaking) speech.toggleSpeak(); setOpen(false); }} aria-label="收起助手"><ChevronDown size={21} /></button><button onClick={() => { speech.cancelListening(); if (speech.speaking) speech.toggleSpeak(); pause(); setOpen(false); }} aria-label="关闭助手面板"><X size={19} /></button></header>
      <p className={styles.context}>已共享：{pageName} · 密码和验证码不共享</p>
      <div className={styles.messages}>
        {!messages.length && !run && <><p className={styles.intro}>告诉我你想办理什么。我会先核对页面信息，必要时向你追问。涉及账户操作，由你确认。</p><div className={styles.choices}>{["查一下我的余额", "分析本月账单", "查看我的卡片"].map(prompt => <button key={prompt} disabled={busy || !configured} onClick={() => send(prompt)}>{prompt}</button>)}</div><a className={styles.channelLink} href="/channels">连接 QQ / 企业微信</a></>}
        {messages.map((message, index) => <p key={index} className={message.role === "user" ? styles.user : styles.assistant}>{message.text}</p>)}
        {run && <p className={styles.assistant}>{run.message}</p>}
        {run?.timeline ? <TaskTimeline events={run.timeline} /> : <StepList items={steps} />}
        {question && <div className={styles.choices} aria-label={question.question}>{question.options.map((option) => <button key={option} disabled={busy} onClick={() => option === "自行输入" ? answerInput.current?.focus() : void send(option)}>{option}</button>)}<small>也可以在下方直接输入，无默认选项。</small></div>}
        {run?.status === "CONSENT" && <div className={styles.consent}><p>是否允许我接管页面？你操作页面时我会暂停，业务确认与强验证由你完成。</p><button disabled={busy} onClick={continueRun}>允许代操作</button><button disabled={busy} onClick={cancel}>暂不允许</button></div>}
        {(run?.status === "PAUSED" || run?.status === "HANDOFF") && !question && <div className={styles.controls}><button disabled={busy} onClick={continueRun}>{run.controlGranted ? "继续 · 重新读取页面" : run.status === "HANDOFF" ? "我已操作 · 查看页面" : "允许代操作"}</button><button disabled={busy} onClick={cancel}>结束</button></div>}
        {busy && <p className={styles.progress}>正在处理…</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {!configured && <p className={styles.error}>助手模型暂不可用；仍可输入明确的偏好管理指令，或通过页面办理业务。</p>}
        <div ref={historyEnd} />
      </div>
      <div className={styles.voiceTools}>
        <label>识别语言 <select aria-label="识别语言" value={speechLanguage} disabled={speech.listening} onChange={(event) => setSpeechLanguage(event.target.value as SpeechLanguage)}><option value="zh-CN">普通话</option><option value="zh-HK">粤语</option></select></label>
        {run?.message && <button type="button" onClick={() => speech.toggleSpeak(run.message)} aria-label={speech.speaking ? "停止播报" : "播报助手回复"}><Volume2 size={17} />{speech.speaking ? "停止播报" : "播报回复"}</button>}
      </div>
      <p className={styles.voiceHint} role="note">{speech.hint}</p>
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}><input ref={answerInput} aria-label="向悬浮助手描述需求或回答问题" placeholder={question ? "选择选项，或直接输入…" : "描述你想办理的业务…"} value={input} onChange={(event) => setInput(event.target.value)} maxLength={1000} /><button type="button" className={styles.micButton} aria-label={speech.listening ? "停止录音" : "语音输入"} aria-pressed={speech.listening} disabled={!configured || busy} onClick={speech.toggleListening}>{speech.listening ? <Square size={17} /> : <Mic size={18} />}</button><button aria-label="发送给悬浮助手" disabled={(!configured && !parsePreferenceCommand(input)) || busy || speech.listening || !input.trim()}><Send size={18} /></button></form>
    </section>}
  </div>;
}
