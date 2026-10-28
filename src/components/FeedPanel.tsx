"use client";

import { ArrowUpRight, Eye, EyeOff, MessageCircle, Plus, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useState, type PointerEvent, type ReactNode } from "react";
import { publishedLabel, yuan, type FeedChart, type FeedKind, type FeedPost } from "@/lib/feed";
import { AssistantMark } from "./AssistantMark";
import styles from "./FeedPanel.module.css";

type Reaction = "up" | "down";
// kinds 是每类帖子的口味分；mutedSince 记录某类被踩成负分的时间，此后新发的同类帖子不再显示。
type Taste = { reactions: Record<string, Reaction>; kinds: Partial<Record<FeedKind, number>>; mutedSince?: Partial<Record<FeedKind, string>> };
export type FeedQuote = { id: string; title: string; text: string };

// 演示账户由所有访客共用，口味只记在本浏览器、按用户区分，不写进共享账户。
const tasteKey = (owner: string) => `bankpilot-feed-taste:v1:${owner}`;
function readTaste(owner: string): Taste {
  try {
    const value = JSON.parse(localStorage.getItem(tasteKey(owner)) ?? "null");
    if (value && typeof value === "object" && value.reactions && value.kinds) return value;
  } catch { /* 损坏的本地记录按空口味处理 */ }
  return { reactions: {}, kinds: {} };
}

// 赞踩只影响以后：读取时过滤掉"被踩之后才发布"的同类帖子，已经看过的保留，当前列表也不跳动。
// 需要你看看的帖子不受口味影响。
function visible(posts: FeedPost[], taste: Taste) {
  return posts.filter(post => {
    const since = taste.mutedSince?.[post.kind];
    return post.attention || !since || (taste.kinds[post.kind] ?? 0) >= 0 || post.publishedAt <= since;
  });
}

// 首页就是动态流；pinned 是默认置顶的组件（例如资产卡），和帖子用同一个卡片外壳。
export function FeedPanel({ owner, onDiscuss, pinned }: { owner: string; onDiscuss: (quote: FeedQuote) => void; pinned?: ReactNode }) {
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [taste, setTaste] = useState<Taste>({ reactions: {}, kinds: {} });
  useEffect(() => {
    let alive = true;
    fetch("/api/v1/feed", { cache: "no-store" }).then(async response => {
      const result = await response.json().catch(() => null);
      if (!alive) return;
      if (!response.ok || !Array.isArray(result?.posts)) { setFailed(true); return; }
      const saved = readTaste(owner);
      setTaste(saved); setPosts(visible(result.posts, saved));
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [owner]);

  const react = (post: FeedPost, reaction: Reaction) => {
    setTaste(current => {
      const previous = current.reactions[post.id];
      const next = previous === reaction ? undefined : reaction;
      const delta = (next === "up" ? 1 : next === "down" ? -1 : 0) - (previous === "up" ? 1 : previous === "down" ? -1 : 0);
      const reactions = { ...current.reactions };
      if (next) reactions[post.id] = next; else delete reactions[post.id];
      const score = (current.kinds[post.kind] ?? 0) + delta;
      const mutedSince = { ...current.mutedSince };
      if (score < 0) mutedSince[post.kind] ??= new Date().toISOString(); else delete mutedSince[post.kind];
      const updated = { reactions, kinds: { ...current.kinds, [post.kind]: score }, mutedSince };
      try { localStorage.setItem(tasteKey(owner), JSON.stringify(updated)); } catch { /* 存储不可用时仅本次有效 */ }
      return updated;
    });
  };

  return <section className={styles.feed} aria-label="动态">
    <div className={styles.head}><h1>动态</h1><span>BankPilot 根据你的账户整理</span></div>
    {pinned}
    {failed ? <p className={styles.empty}>动态暂时无法读取，稍后再来看看。</p>
      : posts === null ? <p className={styles.empty} role="status">正在整理…</p>
      : posts.length === 0 ? <p className={styles.empty}>今天一切正常，没有新动态。</p>
      : posts.map(post => <article key={post.id} className={styles.post} data-attention={post.attention || undefined} aria-label={post.title}>
        {post.attention && <span className={styles.flag}>需要你看看</span>}
        <h3>{post.title}</h3>
        <Chart chart={post.chart} />
        <p className={styles.body}>{post.body}</p>
        <footer>
          <span className={styles.byline}><AssistantMark size={14} /><time dateTime={post.publishedAt}>{publishedLabel(post.publishedAt)}</time> · {post.source}</span>
          <span className={styles.actions}>
            <button aria-label="赞" aria-pressed={taste.reactions[post.id] === "up"} onClick={() => react(post, "up")}><ThumbsUp size={17} /></button>
            <button aria-label="踩" aria-pressed={taste.reactions[post.id] === "down"} onClick={() => react(post, "down")}><ThumbsDown size={17} /></button>
            <button className={styles.discuss} onClick={() => onDiscuss({ id: post.id, title: post.title, text: `${post.title}。${post.body}` })}><MessageCircle size={17} />讨论</button>
          </span>
        </footer>
        {taste.reactions[post.id] === "down" && <p className={styles.tasteNote} role="status">收到，以后少发这类。</p>}
      </article>)}
  </section>;
}

function Chart({ chart }: { chart: FeedChart }) {
  if (chart.type === "calendar") return <CalendarChart days={chart.days} />;
  if (chart.type === "flow") return <FlowChart chart={chart} />;
  if (chart.type === "bars") return <BarChart items={chart.items} />;
  if (chart.type === "diverging") return <DivergingChart items={chart.items} />;
  if (chart.type === "timeline") return <TimelineChart chart={chart} />;
  if (chart.type === "line") return <LineChart chart={chart} />;
  if (chart.type === "countdown") return <div className={styles.hero}><b>{chart.days}<span> 天</span></b><Pips days={chart.days} /><small>{chart.caption}</small></div>;
  return <div className={styles.hero}><b>{yuan(chart.minor)}</b><small>{chart.caption}</small></div>;
}

const dayLabel = (date: string) => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;

function CalendarChart({ days }: { days: Array<{ date: string; minor: number; future?: boolean }> }) {
  const [active, setActive] = useState<number | null>(null);
  const spent = days.map(day => day.minor).filter(Boolean).sort((a, b) => a - b);
  // 4 档颜色按有消费日的分位切分，避免一笔大额把其余日子都压成最浅。
  const cut = [0.25, 0.5, 0.75].map(q => spent[Math.min(spent.length - 1, Math.floor(q * spent.length))] ?? 0);
  const level = (minor: number) => minor <= 0 ? 0 : 1 + cut.filter(value => minor > value).length;
  const shown = active === null ? null : days[active];
  return <figure className={styles.figure}>
    <div className={styles.calendar} role="img" aria-label={`近 5 周每日消费，最多的一天 ${yuan(Math.max(0, ...spent))}`}>
      {["一", "二", "三", "四", "五", "六", "日"].map(name => <span key={name} className={styles.weekday}>{name}</span>)}
      {days.map((day, index) => day.future ? <span key={day.date} className={styles.cell} data-future aria-hidden="true" />
        : <span key={day.date} className={styles.cell} data-level={level(day.minor)} data-active={active === index || undefined}
          tabIndex={0} aria-label={`${dayLabel(day.date)} ${day.minor ? yuan(day.minor) : "无消费"}`}
          onPointerEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)} />)}
    </div>
    <figcaption className={styles.readout}>
      <span>{shown ? `${dayLabel(shown.date)} · ${shown.minor ? yuan(shown.minor) : "没有消费"}` : "点一个格子看当天金额"}</span>
      <span className={styles.scale} aria-hidden="true">少{[1, 2, 3, 4].map(step => <i key={step} data-level={step} />)}多</span>
    </figcaption>
  </figure>;
}

function FlowChart({ chart }: { chart: Extract<FeedChart, { type: "flow" }> }) {
  const [active, setActive] = useState<number | null>(null);
  return <figure className={styles.figure}>
    <div className={styles.flowBar} role="img" aria-label={chart.parts.map(part => `${part.label} ${yuan(part.minor)}`).join("，")}>
      {chart.parts.map((part, index) => <span key={part.label} data-series={part.label === "其他" ? "other" : index + 1} data-active={active === index || undefined}
        style={{ flexGrow: part.minor }} onPointerEnter={() => setActive(index)} onPointerLeave={() => setActive(null)} />)}
    </div>
    <ul className={styles.legend}>
      {chart.parts.map((part, index) => <li key={part.label} data-active={active === index || undefined} onPointerEnter={() => setActive(index)} onPointerLeave={() => setActive(null)}>
        <i data-series={part.label === "其他" ? "other" : index + 1} /><span>{part.label}</span><b>{yuan(part.minor)}</b><small>{Math.round(part.minor / chart.outMinor * 100)}%</small>
      </li>)}
    </ul>
  </figure>;
}

function BarChart({ items }: { items: Array<{ label: string; minor: number; note: string }> }) {
  const max = Math.max(...items.map(item => item.minor));
  return <ul className={styles.bars} aria-label="订阅金额">
    {items.map(item => <li key={item.label}>
      <span className={styles.barLabel}>{item.label}</span>
      <span className={styles.track}><span className={styles.bar} style={{ width: `${Math.max(4, item.minor / max * 100)}%` }} /></span>
      <b>{yuan(item.minor)}</b><small>{item.note}</small>
    </li>)}
  </ul>;
}

function DivergingChart({ items }: { items: Array<{ label: string; netMinor: number }> }) {
  const max = Math.max(...items.map(item => Math.abs(item.netMinor)), 1);
  return <figure className={styles.figure}>
    <div className={styles.divergeAxis} aria-hidden="true"><span>你转出多</span><span>对方转来多</span></div>
    <ul className={styles.diverging} aria-label="朋友间净转账">
      {items.map(item => <li key={item.label}>
        <span className={styles.barLabel}>{item.label}</span>
        <span className={styles.split}>
          <span className={styles.half}>{item.netMinor < 0 && <span className={styles.out} style={{ width: `${Math.max(6, -item.netMinor / max * 100)}%` }} />}</span>
          <span className={styles.half}>{item.netMinor > 0 && <span className={styles.in} style={{ width: `${Math.max(6, item.netMinor / max * 100)}%` }} />}</span>
        </span>
        <b>{item.netMinor === 0 ? "持平" : `${item.netMinor > 0 ? "+" : "−"}${yuan(item.netMinor)}`}</b>
      </li>)}
    </ul>
  </figure>;
}

const daysFrom = (start: string, date: string) => Math.round((new Date(`${date}T12:00:00+08:00`).getTime() - new Date(`${start}T12:00:00+08:00`).getTime()) / 86_400_000);
const shiftDay = (start: string, days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(new Date(`${start}T12:00:00+08:00`).getTime() + days * 86_400_000));
const shortDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 甘特式扣费时间线：每个订阅一行，圆点落在扣费日，左边竖线是今天。
function TimelineChart({ chart }: { chart: Extract<FeedChart, { type: "timeline" }> }) {
  const at = (date: string) => daysFrom(chart.start, date) / (chart.days - 1) * 100;
  const ticks = [0, 7, 14, 21, chart.days - 1];
  return <figure className={styles.figure}>
    <div className={styles.timeline} role="img" aria-label={chart.items.map(item => `${item.label} ${shortDay(item.date)} 扣 ${yuan(item.minor)}`).join("，")}>
      <div className={styles.timelineAxis} aria-hidden="true"><span />{<span className={styles.timelineTicks}>{ticks.map(tick => <i key={tick} style={{ left: `${tick / (chart.days - 1) * 100}%` }}>{tick === 0 ? "今天" : shortDay(shiftDay(chart.start, tick))}</i>)}</span>}</div>
      {chart.items.map(item => {
        const position = at(item.date);
        const days = daysFrom(chart.start, item.date);
        return <div key={`${item.label}-${item.date}`} className={styles.timelineRow} data-highlight={item.highlight || undefined}>
          <span className={styles.barLabel}>{item.label}</span>
          <span className={styles.timelineTrack}>
            {ticks.map(tick => <i key={tick} className={styles.gridLine} style={{ left: `${tick / (chart.days - 1) * 100}%` }} />)}
            <span className={styles.runway} style={{ width: `${position}%` }} />
            <span className={styles.dot} style={{ left: `${position}%` }} />
            <b className={styles.dotLabel} data-side={position > 60 ? "left" : "right"} style={{ left: `${position}%` }}>{days === 0 ? "今天" : `${days} 天`} · {yuan(item.minor)}</b>
          </span>
        </div>;
      })}
    </div>
  </figure>;
}

// 持仓走势：单系列折线加面积，虚线是投入本金；指向任意位置看当天估值。
function LineChart({ chart }: { chart: Extract<FeedChart, { type: "line" }> }) {
  const [active, setActive] = useState<number | null>(null);
  const width = 320, height = 120, pad = 6;
  const values = chart.points.map(point => point.minor).concat(chart.baselineMinor);
  const low = Math.min(...values), high = Math.max(...values);
  const span = Math.max(1, high - low);
  const x = (index: number) => index / Math.max(1, chart.points.length - 1) * width;
  const y = (minor: number) => pad + (1 - (minor - low) / span) * (height - pad * 2);
  const line = chart.points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.minor).toFixed(1)}`).join("");
  const area = `${line}L${width},${height}L0,${height}Z`;
  const shown = chart.points[active ?? chart.points.length - 1];
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(Math.max(0, Math.min(chart.points.length - 1, Math.round((event.clientX - box.left) / box.width * (chart.points.length - 1)))));
  };
  const index = active ?? chart.points.length - 1;
  return <figure className={styles.figure}>
    <div className={styles.lineWrap}>
    <svg className={styles.line} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
      aria-label={`${shortDay(chart.points[0].date)} 到 ${shortDay(chart.points.at(-1)!.date)}，从 ${yuan(chart.points[0].minor)} 到 ${yuan(chart.points.at(-1)!.minor)}`}
      onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)}>
      <path d={area} className={styles.lineArea} />
      <line x1={0} x2={width} y1={y(chart.baselineMinor)} y2={y(chart.baselineMinor)} className={styles.baseline} />
      <path d={line} className={styles.linePath} />
      {active !== null && <line x1={x(index)} x2={x(index)} y1={0} y2={height} className={styles.crosshair} />}
    </svg>
    <span className={styles.lineDot} style={{ left: `${x(index) / width * 100}%`, top: `${y(chart.points[index].minor) / height * 100}%` }} aria-hidden="true" />
    </div>
    <figcaption className={styles.readout}>
      <span>{shortDay(shown.date)} · {yuan(shown.minor)}</span>
      <span className={styles.baselineKey}><i />{chart.baselineLabel} {yuan(chart.baselineMinor)}</span>
    </figcaption>
  </figure>;
}

// 倒数的小格子：一格一天，最多显示 7 格。
function Pips({ days }: { days: number }) {
  return <span className={styles.pips} aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <i key={index} data-on={index < 7 - Math.min(7, days) || undefined} />)}</span>;
}

// 资产卡：默认置顶的组件。转账和入金入口留在这里，AI 代操作时也从这里打开表单。
export function AssetCard({ totalMinor, cashMinor, investedMinor, visible, toggleVisible, disabled, onTransfer, onDeposit, onDiscuss }: {
  totalMinor: number; cashMinor: number; investedMinor: number; visible: boolean; toggleVisible: () => void; disabled: boolean;
  onTransfer: () => void; onDeposit: () => void; onDiscuss: (quote: FeedQuote) => void;
}) {
  const parts = [{ label: "活期", minor: cashMinor, series: 1 }, { label: "理财", minor: investedMinor, series: 3 }].filter(part => part.minor > 0);
  const amount = (minor: number) => visible ? yuan(minor) : "••••";
  const exact = (minor: number) => visible ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(minor / 100) : "••••••";
  return <article className={styles.post} aria-label="资产" data-pinned>
    <div className={styles.assetHead}><span>总资产 · CNY</span>
      <button onClick={toggleVisible} aria-label={visible ? "隐藏余额" : "显示余额"} aria-pressed={!visible}>{visible ? <Eye size={18} /> : <EyeOff size={18} />}</button></div>
    <div className={styles.assetTotal}>{exact(totalMinor)}</div>
    {parts.length > 1 && <figure className={styles.figure}>
      <div className={styles.flowBar} role="img" aria-label={parts.map(part => `${part.label} ${amount(part.minor)}`).join("，")}>
        {parts.map(part => <span key={part.label} data-series={part.series} style={{ flexGrow: part.minor }} />)}
      </div>
      <ul className={styles.legend}>{parts.map(part => <li key={part.label}><i data-series={part.series} /><span>{part.label}</span><b>{amount(part.minor)}</b><small>{Math.round(part.minor / totalMinor * 100)}%</small></li>)}</ul>
    </figure>}
    <footer>
      <span className={styles.byline}><AssistantMark size={14} />实时 · 置顶</span>
      <span className={styles.actions}>
        <button data-agent-id="open-transfer" data-agent-permission="navigate" disabled={disabled} onClick={onTransfer}><ArrowUpRight size={17} />转账</button>
        <button data-agent-id="open-deposit" data-agent-permission="navigate" disabled={disabled} onClick={onDeposit}><Plus size={17} />入金</button>
        <button className={styles.discuss} onClick={() => onDiscuss({ id: "assets", title: "我的资产", text: `总资产 ${yuan(totalMinor)}，其中活期 ${yuan(cashMinor)}、理财 ${yuan(investedMinor)}。` })}><MessageCircle size={17} />讨论</button>
      </span>
    </footer>
  </article>;
}
