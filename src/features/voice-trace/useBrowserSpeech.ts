"use client";

import { useEffect, useRef, useState } from "react";

export type SpeechLanguage = "zh-CN" | "zh-HK";
type RecognitionEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type Recognition = {
  lang: string; interimResults: boolean; maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

export function useBrowserSpeech(onTranscript: (text: string) => void, language: SpeechLanguage) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [hint, setHint] = useState("点麦克风说话（识别由浏览器厂商服务处理，请勿口述密码等敏感信息），识别后先核对文字再发送。");
  const recognition = useRef<Recognition | null>(null);
  const transcriptCallback = useRef(onTranscript);
  useEffect(() => { transcriptCallback.current = onTranscript; }, [onTranscript]);

  useEffect(() => () => {
    recognition.current?.abort();
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const stopListening = () => {
    recognition.current?.stop();
    recognition.current = null;
    setListening(false);
  };
  const cancelListening = () => {
    if (recognition.current) {
      recognition.current.onresult = null;
      recognition.current.abort();
      recognition.current = null;
    }
    setListening(false);
  };
  const toggleListening = () => {
    if (listening) { stopListening(); return; }
    const browser = window as SpeechWindow;
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) { setHint("当前浏览器不支持语音识别，请直接输入文字。"); return; }
    const current = new Constructor();
    current.lang = language;
    current.interimResults = false;
    current.maxAlternatives = 1;
    current.onresult = (event) => {
      // Concatenate every finalized segment: long utterances arrive as
      // multiple results and dropping the tail loses dictated amounts.
      const text = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join("").trim();
      if (text) { transcriptCallback.current(text); setHint("识别完成，请核对文字，必要时修改，然后点发送。"); }
      else setHint("没有识别到内容，请重试或直接输入。");
    };
    current.onerror = (event) => {
      setListening(false);
      setHint(event.error === "not-allowed" ? "麦克风权限被拒绝，请允许使用或直接输入文字。" : "语音识别未完成，请重试或直接输入文字。");
    };
    current.onend = () => { setListening(false); if (recognition.current === current) recognition.current = null; };
    recognition.current = current;
    try { current.start(); setListening(true); setHint("正在听（识别由浏览器厂商服务处理，请勿口述密码等敏感信息）。点“停止录音”可结束。"); }
    catch { recognition.current = null; setHint("麦克风暂时无法启动，请直接输入文字。"); }
  };

  const toggleSpeak = (reply?: string) => {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") { setHint("当前浏览器不支持语音播报，请阅读屏幕文字。"); return; }
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    if (!reply) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(reply);
    utterance.lang = language;
    utterance.rate = 0.85;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => { setSpeaking(false); setHint("播报没有完成，请阅读屏幕文字。"); };
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  return { listening, speaking, hint, setHint, stopListening, cancelListening, toggleListening, toggleSpeak };
}
