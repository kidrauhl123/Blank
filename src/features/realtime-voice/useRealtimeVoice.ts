"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";
type Resources = { socket?: WebSocket; stream?: MediaStream; context?: AudioContext; capture?: AudioWorkletNode; input?: MediaStreamAudioSourceNode; silence?: GainNode; sources: Set<AudioBufferSourceNode>; nextAt: number; ready: boolean; timer?: number; timeout?: number };
function clearPlayback(current: Resources) {
    for (const source of current.sources) { source.onended = null; try { source.stop(); } catch { /* Playback may already have ended. */ } source.disconnect(); }
    current.sources.clear(); current.nextAt = 0;
}

export function useRealtimeVoice(onMessage: (role: "user" | "assistant", text: string) => void) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [proposal, setProposal] = useState<string | null>(null);
  const resources = useRef<Resources | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const onMessageRef = useRef(onMessage);
  const lastReply = useRef("");
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  const dispose = useCallback(() => {
    generation.current++;
    const current = resources.current; resources.current = null;
    if (!current) return;
    window.clearInterval(current.timer); window.clearTimeout(current.timeout);
    current.ready = false;
    current.capture?.port.close(); current.capture?.disconnect(); current.input?.disconnect(); current.silence?.disconnect();
    current.stream?.getTracks().forEach(track => track.stop());
    clearPlayback(current);
    if (current.context && current.context.state !== "closed") void current.context.close().catch(() => {});
    if (current.socket) { current.socket.onmessage = null; current.socket.onclose = null; current.socket.onerror = null; current.socket.onopen = null; current.socket.close(); }
  }, []);
  const stop = useCallback(() => { dispose(); if (alive.current) { setStatus("ended"); setMuted(false); } }, [dispose]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; dispose(); };
  }, [dispose]);
  const start = async () => {
    dispose();
    const turn = generation.current;
    const current: Resources = { sources: new Set(), nextAt: 0, ready: false };
    resources.current = current;
    const valid = () => alive.current && generation.current === turn;
    const fail = (message: string) => { if (!valid()) return; dispose(); setError(message); setStatus("error"); };
    setStatus("connecting"); setError(""); setCaption(""); setHeard(""); setMuted(false); setSeconds(0); setProposal(null); lastReply.current = "";
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("UNSUPPORTED");
      try { current.context = new AudioContext({ sampleRate: 24000 }); } catch { current.context = new AudioContext(); }
      const context = current.context;
      await context.resume();
      if (!valid()) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!valid()) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      stream.getAudioTracks().forEach(track => { track.onended = () => fail("麦克风已断开，请重新拨打。"); });
      await context.audioWorklet.addModule("/voice/capture.js");
      if (!valid()) return;
      const input = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, "bank-voice-capture");
      const silence = context.createGain(); silence.gain.value = 0;
      input.connect(capture); capture.connect(silence); silence.connect(context.destination);
      Object.assign(current, { input, capture, silence });
      const url = new URL("/api/voice/live", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url); current.socket = socket;
      current.timeout = window.setTimeout(() => fail("语音连接超时，请稍后重拨。"), 30000);
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!valid() || !current.ready || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 262144) { fail("连接较慢，请检查网络后重新拨打。"); return; }
        const bytes = new Uint8Array(event.data);
        socket.send(JSON.stringify({ type: "audio", audio: btoa(String.fromCharCode(...bytes)) }));
      };
      socket.onmessage = event => {
        if (!valid()) return;
        let data: { type: string; audio?: string; delta?: string; text?: string; message?: string; request?: string };
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === "bank.ready") {
          current.ready = true; window.clearTimeout(current.timeout); setStatus("listening");
          const connected = Date.now(); current.timer = window.setInterval(() => { if (valid()) setSeconds(Math.floor((Date.now() - connected) / 1000)); }, 1000);
        } else if (data.type === "bank.listening") { clearPlayback(current); setStatus("listening"); setCaption(""); }
        else if (data.type === "bank.thinking") setStatus("thinking");
        else if (data.type === "bank.response.started") { setCaption(""); lastReply.current = ""; setStatus("thinking"); }
        else if (data.type === "bank.audio" && data.audio) {
          try {
            const raw = atob(data.audio), bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            if (bytes.byteLength % 2) return;
            const view = new DataView(bytes.buffer), buffer = context.createBuffer(1, bytes.length / 2, 24000), samples = buffer.getChannelData(0);
            for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
            if (current.nextAt - context.currentTime > 30) { fail("语音播放已中断，请重新拨打。"); return; }
            const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); current.sources.add(source);
            source.onended = () => { current.sources.delete(source); source.disconnect(); if (valid() && !current.sources.size) setStatus("listening"); };
            const at = Math.max(context.currentTime + .025, current.nextAt); source.start(at); current.nextAt = at + buffer.duration; setStatus("speaking");
          } catch { fail("无法播放语音，请重新拨打或使用文字沟通。"); }
        } else if (data.type === "bank.caption.delta") setCaption(text => (text + (data.delta || "")).slice(-4000));
        else if (data.type === "bank.caption.done") {
          const text = data.text?.trim();
          if (text) { setCaption(text); if (lastReply.current !== text) { lastReply.current = text; onMessageRef.current("assistant", text); } }
        } else if (data.type === "bank.user" && data.text) { setHeard(data.text); onMessageRef.current("user", data.text); }
        else if (data.type === "bank.task_proposal" && data.request) setProposal(data.request);
        else if (data.type === "bank.response.done" && !current.sources.size) setStatus("listening");
        else if (data.type === "bank.error") fail(data.message || "语音连接已中断，请重新拨打。");
      };
      socket.onerror = () => fail("暂时无法连接语音服务，请稍后重拨。");
      socket.onclose = () => { if (valid()) { dispose(); setStatus("ended"); } };
    } catch (reason) {
      const denied = reason instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(reason.name);
      fail(denied ? "需要允许麦克风才能通话，也可以继续使用文字。" : reason instanceof Error && reason.message === "UNSUPPORTED" ? "当前浏览器不支持实时语音，请使用新版浏览器或文字沟通。" : "无法启动麦克风，请检查设备后重试。");
    }
  };
  const toggleMute = () => {
    const current = resources.current;
    if (!current?.ready) return;
    const next = !muted; current.stream?.getAudioTracks().forEach(track => { track.enabled = !next; }); setMuted(next);
  };
  const interrupt = () => {
    const current = resources.current;
    if (!current?.ready) return;
    clearPlayback(current);
    if (current.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: "interrupt" }));
    setStatus("listening");
  };
  return { status, error, caption, heard, muted, seconds, proposal, start, stop, toggleMute, interrupt };
}
export type RealtimeVoice = ReturnType<typeof useRealtimeVoice>;
