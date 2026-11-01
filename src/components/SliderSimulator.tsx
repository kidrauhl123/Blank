"use client";

import { useState } from "react";
import type { SliderSpec } from "@/lib/tool-spec";
import { formatYuan, simulateSavings, type CurvePoint } from "@/lib/tool-calc";
import styles from "./ToolCard.module.css";

const W = 320, H = 150, PAD_X = 8, PAD_TOP = 20, PAD_BOTTOM = 20;

// 滑块模拟器：拖动时用本地公式同步重算，不请求服务端，基础数据已经随卡片给出。
export function SliderSimulator({ spec, monthlyNetMinor }: { spec: SliderSpec; monthlyNetMinor: number }) {
  const [extraYuan, setExtraYuan] = useState(0);
  // 出发月份取决于“现在”，只在挂载时取一次，拖动时不会跳。
  const [now] = useState(() => new Date());
  const targetMinor = spec.targetYuan * 100;
  const savedMinor = spec.savedYuan * 100;
  const extraMinor = extraYuan * 100;
  const { baselineMonths, months, monthsEarlier, departure, baselineDeparture, curve } = simulateSavings({ targetMinor, savedMinor, baseMonthlyMinor: monthlyNetMinor }, extraMinor, now);
  // 基线攒不到而现在能攒到时没有“提前几个月”，要单独说清楚。
  const headline = months === null ? "按这个速度还攒不到，再往右拖一点"
    : baselineMonths === null ? `原来攒不到，现在 ${months} 个月`
    : monthsEarlier !== null && monthsEarlier > 0 ? `提前 ${monthsEarlier} 个月`
    : "和现在一样";

  return <>
    <p className={styles.note}>{monthlyNetMinor > 0 ? `按你最近的节奏，每月大约能攒 ${formatYuan(monthlyNetMinor)}` : "按你最近的节奏，现在每月攒不下钱"}</p>
    <div className={styles.sliderRow}>
      <span>每月再多存</span>
      <input type="range" aria-label="每月再多存" min={0} max={spec.sliderMaxYuan} step={spec.stepYuan} value={extraYuan}
        aria-valuetext={`每月多存 ${formatYuan(extraMinor)}`} onChange={event => setExtraYuan(Number(event.target.value))} />
      <span className={styles.sliderValue}>+{formatYuan(extraMinor)} / 月</span>
    </div>
    <p className={styles.departure}>预计出发 <b>{departure ? `${departure.year} 年 ${departure.month} 月` : "暂时没有日期"}</b>
      {baselineDeparture && <>，按现在的节奏是 {baselineDeparture.year} 年 {baselineDeparture.month} 月</>}</p>
    <p className={styles.big}>{headline}</p>
    <CurveChart curve={curve} targetMinor={targetMinor} savedMinor={savedMinor} extraMinor={extraMinor} />
  </>;
}

// 双折线：灰色虚线是按现在的节奏，绿色实线是每月多存之后。横轴是月数，只标首尾，纵轴不画刻度。
function CurveChart({ curve, targetMinor, savedMinor, extraMinor }: { curve: CurvePoint[]; targetMinor: number; savedMinor: number; extraMinor: number }) {
  const last = curve[curve.length - 1].month;
  const top = Math.max(targetMinor, savedMinor);
  const x = (month: number) => PAD_X + (month / last) * (W - PAD_X * 2);
  const y = (minor: number) => PAD_TOP + (1 - minor / top) * (H - PAD_TOP - PAD_BOTTOM);
  const path = (key: "baseline" | "adjusted") => curve.map(point => `${x(point.month).toFixed(1)},${y(point[key]).toFixed(1)}`).join(" ");
  return <>
    <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`累计存款曲线，目标 ${formatYuan(targetMinor)}。虚线是按现在的节奏，实线是每月多存 ${formatYuan(extraMinor)}`}>
      <line x1={PAD_X} x2={W - PAD_X} y1={y(targetMinor)} y2={y(targetMinor)} className={styles.targetLine} />
      <text x={PAD_X} y={y(targetMinor) - 6} className={styles.chartLabel}>目标 {formatYuan(targetMinor)}</text>
      <polyline points={path("baseline")} className={styles.baselineLine} />
      <polyline points={path("adjusted")} className={styles.adjustedLine} />
      <text x={PAD_X} y={H - 4} className={styles.chartLabel}>现在</text>
      <text x={W - PAD_X} y={H - 4} textAnchor="end" className={styles.chartLabel}>{last} 个月后</text>
    </svg>
    <p className={styles.legend}><span><i data-line="baseline" />按现在的节奏</span><span><i data-line="adjusted" />每月多存 {formatYuan(extraMinor)}</span></p>
  </>;
}
