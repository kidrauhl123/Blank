"use client";

import { useState, type FormEvent } from "react";
import { Mic, Send, Square, Volume2 } from "lucide-react";
import { useBrowserSpeech } from "./useBrowserSpeech";
import styles from "./VoiceTraceDemo.module.css";

export function VoiceComposer({ onSubmit, reply, disabled = false }: { onSubmit: (text: string) => void; reply?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const speech = useBrowserSpeech(setDraft, "zh-CN");

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    if (speech.listening) speech.stopListening();
    onSubmit(text);
    setDraft("");
    speech.setHint("已发送文字。需要时可再次点麦克风。");
  };

  return <div className={styles.voiceCard}>
    <div className={styles.voiceHeading}><h2>语音与文字</h2></div>
    <form onSubmit={send}>
      <label htmlFor="voice-draft">你的需求</label>
      <textarea id="voice-draft" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1000} rows={3} placeholder="例如：帮我查看本月账单" />
      <p className={styles.hint} role="status">{speech.hint}</p>
      <div className={styles.actions}>
        <button type="button" className={speech.listening ? styles.stop : styles.secondary} aria-pressed={speech.listening} onClick={speech.toggleListening}>{speech.listening ? <Square size={18} /> : <Mic size={18} />}{speech.listening ? "停止录音" : "点一下说话"}</button>
        <button type="submit" className={styles.primary} disabled={disabled || !draft.trim()}><Send size={18} />核对后发送</button>
      </div>
    </form>
    {reply && <div className={styles.reply}><p>{reply}</p><button type="button" className={styles.secondary} onClick={() => speech.toggleSpeak(reply)}><Volume2 size={18} />{speech.speaking ? "停止播报" : "播报这段回复"}</button></div>}
  </div>;
}
