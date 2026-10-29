"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./AssistantMarkdown.module.css";
import { RecipeCardById } from "./FeedPanel";
import { ScheduleCardById } from "./ScheduleCard";

// 回复里的 [[card:编号]]（动态卡片）、[[schedule:编号]]（定时任务）渲染成真正的预览卡片；流式输出中尚未写完的标记先隐藏。
// 去掉标记，只留给人读的文字（步骤记录、无障碍标签等不需要卡片的地方用）。
export const stripMarkers = (text: string) => text.replace(/\[\[(?:card|schedule):[0-9a-f-]{36}\]\]\s*/g, "").trim();
const MARKER = /\[\[(card|schedule):([0-9a-f-]{36})\]\]/g;
const UNFINISHED = /\[\[(?:[a-z]{0,8}(?::[0-9a-f-]{0,35})?)?$/;
export function AssistantMarkdown({ text }: { text: string }) {
  const visible = text.replace(UNFINISHED, "");
  const parts = visible.split(MARKER);
  if (parts.length === 1) return <MarkdownText text={visible} />;
  const nodes = [];
  for (let index = 0; index < parts.length; index += 3) {
    if (parts[index].trim()) nodes.push(<MarkdownText key={`t${index}`} text={parts[index]} />);
    const type = parts[index + 1], id = parts[index + 2];
    if (type && id) nodes.push(type === "card" ? <RecipeCardById key={`${type}${id}${index}`} id={id} /> : <ScheduleCardById key={`${type}${id}${index}`} id={id} />);
  }
  return <>{nodes}</>;
}

function MarkdownText({ text }: { text: string }) {
  return <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>{alt || "图片"}</span>,
    table: ({ children }) => <div className={styles.tableScroll} role="region" aria-label="对比表格" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
