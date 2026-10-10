"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./BankingApp.module.css";

export function BankDialog({ title, eyebrow, close, busy = false, children }: {
  title: string; eyebrow: string; close: () => void; busy?: boolean; children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const [previousFocus] = useState(() => typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const node = root.current;
    if (node && !node.contains(document.activeElement)) node.querySelector<HTMLElement>("button:not(:disabled), input")?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, [previousFocus]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (!busy) close(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(item => item.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); root.current?.focus(); }
      else if (!root.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [busy, close]);
  return <div className={styles.modalBackdrop}><section ref={root} className={styles.modal} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} tabIndex={-1}>
    <button data-agent-id="close-modal" data-agent-permission="navigate" className={styles.modalClose} disabled={busy} onClick={close} aria-label="关闭"><X size={20} /></button>
    <p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2>{children}
    {busy && <small role="status">正在处理，请稍候…</small>}
  </section></div>;
}
