"use client";

import { AudioLines, Mic, MicOff, PhoneOff, RotateCcw } from "lucide-react";
import FluidOrb from "@/components/ui/fluid-orb";
import type { RealtimeVoice } from "./useRealtimeVoice";
import styles from "./VoiceCall.module.css";
const labels = { idle: "语音通话", connecting: "正在接通…", listening: "正在聆听", thinking: "正在思考", speaking: "正在回答", ended: "通话已结束", error: "暂时无法通话" };
export function VoiceCall({ voice, close, continueTask }: { voice: RealtimeVoice; close: () => void; continueTask: (request: string) => void }) {
  const active = ["listening", "thinking", "speaking"].includes(voice.status);
  const orb = voice.status === "speaking" ? { color: "#7a9a43", speed: 2 } : voice.status === "thinking" ? { color: "#adb787", speed: 1.2 } : { color: "#8c9b7b", speed: .5 };
  return <div className={styles.call} role="region" aria-label="实时语音通话">
    <div className={styles.identity}><div className={styles.symbol} aria-hidden="true"><FluidOrb size={208} {...orb} paused={!active && voice.status !== "connecting" || voice.muted} /></div><h2>Blank</h2><p role="status">{voice.muted && active ? "麦克风已静音" : labels[voice.status]}</p>{active && <span className={styles.time}>{String(Math.floor(voice.seconds / 60)).padStart(2, "0")}:{String(voice.seconds % 60).padStart(2, "0")}</span>}</div>
    <div className={styles.captions} aria-live="polite">{voice.heard && <p className={styles.heard}>{voice.heard}</p>}{voice.caption && <p>{voice.caption}</p>}{voice.error && <p className={styles.error} role="alert">{voice.error}</p>}</div>
    {voice.proposal && <div className={styles.proposal}><p>{voice.proposal}</p><button onClick={() => continueTask(voice.proposal!)}>继续办理</button></div>}
    <div className={styles.actions}>{active ? <><button aria-label={voice.muted ? "取消静音" : "静音麦克风"} aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? <MicOff /> : <Mic />}<span>{voice.muted ? "取消静音" : "静音"}</span></button><button onClick={voice.interrupt} disabled={voice.status !== "speaking"}><AudioLines /><span>打断</span></button></> : voice.status !== "connecting" && <button onClick={() => void voice.start()}><RotateCcw /><span>重新拨打</span></button>}<button className={styles.hangup} onClick={close} aria-label="挂断语音通话"><PhoneOff /><span>{active || voice.status === "connecting" ? "挂断" : "返回文字"}</span></button></div>
  </div>;
}
