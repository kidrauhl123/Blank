"use client";

import { useState } from "react";
import { bankRequest, jsonPost } from "@/lib/client-request";
import styles from "./FraudCard.module.css";

export type FraudHold = { reasons: Array<{ code: string; text: string }>; questions: Array<{ id: string; text: string }>; hotline: string };
type Answer = "yes" | "no";

// 反诈拦截卡：说清楚哪里可疑，问几个关键问题（选做，只记入审计，不影响判断），给出 96110，再给出路：强验证继续，或 24 小时后再办。
// 所有原因和问题的文字都来自服务端，这里只负责展示和提交用户自己的选择。
export function FraudHoldPanel({ operationId, card, busy, onHeld }: { operationId: string; card: FraudHold; busy: boolean; onHeld: (holdUntil: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const hold = async () => {
    setPending(true);
    setError("");
    try {
      const result = await bankRequest<{ holdUntil: string }>(`/api/v1/transfers/${encodeURIComponent(operationId)}/hold`, jsonPost({ answers }));
      onHeld(result.holdUntil);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时无法暂缓，请稍后再试。");
    } finally {
      setPending(false);
    }
  };
  return <section className={styles.card} role="alert" aria-label="反诈守护拦截卡">
    <h3>先别急，这笔转账有点可疑</h3>
    <ul className={styles.reasons}>{card.reasons.map(reason => <li key={reason.code}>{reason.text}</li>)}</ul>
    <p className={styles.hotline}>如果对方让你转账、自称客服或公安，请先拨打 <b>{card.hotline}</b>。</p>
    {card.questions.map(question => <fieldset key={question.id} className={styles.question}>
      <legend>{question.text}</legend>
      <label><input type="radio" name={`fraud-${question.id}`} checked={answers[question.id] === "yes"} onChange={() => setAnswers(current => ({ ...current, [question.id]: "yes" }))} />是</label>
      <label><input type="radio" name={`fraud-${question.id}`} checked={answers[question.id] === "no"} onChange={() => setAnswers(current => ({ ...current, [question.id]: "no" }))} />否</label>
    </fieldset>)}
    <p className={styles.note}>要继续，就在下面输入验证器动态码（强验证）。也可以 24 小时后再办，这段时间里这笔钱不会转出。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button type="button" className={styles.secondary} disabled={busy || pending} onClick={() => void hold()}>24 小时后再办</button>
  </section>;
}
