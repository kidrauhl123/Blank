"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import type { SplitRow, SplitSpec } from "@/lib/tool-spec";
import { formatYuan, splitSummaryText, splitTotals, type SplitMode } from "@/lib/tool-calc";
import styles from "./ToolCard.module.css";

const MODES: Array<{ mode: SplitMode; label: string }> = [{ mode: "split", label: "平摊" }, { mode: "mine", label: "我请" }, { mode: "hers", label: "她的" }];
const COPY_LABEL = { idle: "复制账单", done: "已复制", failed: "复制失败" } as const;
const storageKey = (id: string) => `blank-split:${id}`;
const shortDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 每行的选择存在本浏览器里，刷新还在；读出来的值只保留合法的三种，坏数据按平摊处理。
function readModes(id: string): Record<string, SplitMode> {
  if (typeof window === "undefined") return {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(id)) ?? "null");
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter(([, mode]) => MODES.some(option => option.mode === mode))) as Record<string, SplitMode>;
  } catch { return {}; }
}

export function SplitTable({ id, spec, rows, receivedMinor, friendFound }: { id: string; spec: SplitSpec; rows: SplitRow[]; receivedMinor: number; friendFound: boolean }) {
  const [modes, setModes] = useState<Record<string, SplitMode>>(() => readModes(id));
  const [copyState, setCopyState] = useState<keyof typeof COPY_LABEL>("idle");
  const totals = splitTotals(rows, modes, receivedMinor);
  const { friendOwesMinor, remainingMinor } = totals;

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  // 选择即存：同时更新 state 和 localStorage，刷新后仍是上次的选择。
  const setMode = (rowId: string, mode: SplitMode) => {
    const next = { ...modes, [rowId]: mode };
    setModes(next);
    try { window.localStorage.setItem(storageKey(id), JSON.stringify(next)); } catch { /* 存储不可用时只在本次有效 */ }
  };
  // 三个按钮是单选组：方向键移动并选中，和原生单选的键盘行为一致，只有当前选项在 Tab 顺序里。
  const moveMode = (event: KeyboardEvent<HTMLDivElement>, rowId: string, current: SplitMode) => {
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = MODES[(MODES.findIndex(option => option.mode === current) + step + MODES.length) % MODES.length].mode;
    setMode(rowId, next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  };

  if (!friendFound) return <p className={styles.note}>找不到名叫「{spec.friend}」的用户</p>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(splitSummaryText(spec.friend, rows.length, totals));
      setCopyState("done");
    } catch { setCopyState("failed"); }
  };
  // 只派发事件，由 BankingApp 预填转账表单并走现有授权流程；这里不做转账。
  const transfer = () => window.dispatchEvent(new CustomEvent("blank:open-transfer", { detail: { recipient: spec.friend, amountMinor: -remainingMinor } }));
  const settle = remainingMinor > 0 ? `她还需转你 ${formatYuan(remainingMinor)}` : remainingMinor < 0 ? `你多收了 ${formatYuan(-remainingMinor)}，该还她` : "已经算清了";

  return <>
    {rows.length === 0 ? <p className={styles.note}>这几天没有找到支出</p> : <ul className={styles.rows}>
      {rows.map(row => {
        const mode = modes[row.id] ?? "split";
        return <li key={row.id} className={styles.row}>
          <div role="group" aria-label={`${row.label}，${formatYuan(row.amountMinor)}`}>
            <div className={styles.rowHead}><span className={styles.rowDate}>{shortDay(row.date)}</span><span className={styles.rowLabel}>{row.label}</span><b>{formatYuan(row.amountMinor)}</b></div>
            <div role="radiogroup" aria-label={`${row.label}的分账方式`} className={styles.modes} onKeyDown={event => moveMode(event, row.id, mode)}>
              {MODES.map(option => <button key={option.mode} type="button" role="radio" data-mode={option.mode} aria-checked={mode === option.mode}
                tabIndex={mode === option.mode ? 0 : -1} onClick={() => setMode(row.id, option.mode)}>{option.label}</button>)}
            </div>
          </div>
        </li>;
      })}
    </ul>}
    <div className={styles.totals}>
      <div><span>她应付</span><b>{formatYuan(friendOwesMinor)}</b></div>
      {receivedMinor > 0 && <div><span>她已转你</span><b>{formatYuan(receivedMinor)}</b></div>}
    </div>
    <p className={styles.settle}>{settle}</p>
    <div className={styles.bottom}>
      <button type="button" onClick={() => void copy()}>{COPY_LABEL[copyState]}</button>
      {remainingMinor < 0 && <button type="button" className={styles.primary} onClick={transfer}>去转账</button>}
    </div>
  </>;
}
