"use client";

import { MessageCircle, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useState } from "react";
import { yuan, type FeedChart, type FeedKind, type FeedPost } from "@/lib/feed";
import { AssistantMark } from "./AssistantMark";
import styles from "./FeedPanel.module.css";

type Reaction = "up" | "down";
type Taste = { reactions: Record<string, Reaction>; kinds: Partial<Record<FeedKind, number>> };
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

// 赞踩只影响以后：排序在读取时按口味计算一次，当前列表不跟着跳动。
function rank(posts: FeedPost[], taste: Taste) {
  return posts.map((post, index) => ({ post, index, score: (post.attention ? 100 : 0) + (taste.kinds[post.kind] ?? 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.post);
}

export function FeedPanel({ owner, onDiscuss }: { owner: string; onDiscuss: (quote: FeedQuote) => void }) {
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
      setTaste(saved); setPosts(rank(result.posts, saved));
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
      const updated = { reactions, kinds: { ...current.kinds, [post.kind]: (current.kinds[post.kind] ?? 0) + delta } };
      try { localStorage.setItem(tasteKey(owner), JSON.stringify(updated)); } catch { /* 存储不可用时仅本次有效 */ }
      return updated;
    });
  };

  if (failed) return null;
  return <section className={styles.feed} aria-label="动态">
    <div className={styles.head}><h2>动态</h2><span>BankPilot 根据你的账户整理</span></div>
    {posts === null ? <p className={styles.empty} role="status">正在整理…</p>
      : posts.length === 0 ? <p className={styles.empty}>今天一切正常，没有新动态。</p>
      : posts.map(post => <article key={post.id} className={styles.post} data-attention={post.attention || undefined} aria-label={post.title}>
        {post.attention && <span className={styles.flag}>需要你看看</span>}
        <h3>{post.title}</h3>
        <Chart chart={post.chart} />
        <p className={styles.body}>{post.body}</p>
        <footer>
          <span className={styles.byline}><AssistantMark size={14} />BankPilot · {post.source}</span>
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
