"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./AssistantMarkdown.module.css";
import { RecipeCardById } from "./FeedPanel";

// 助手回复里单独一行的 [[card:编号]] 渲染成真正的卡片预览；流式输出中尚未写完的标记先隐藏。
const CARD = /\[\[card:([0-9a-f-]{36})\]\]/g;
export function AssistantMarkdown({ text }: { text: string }) {
  const visible = text.replace(/\[\[(?:c(?:a(?:r(?:d(?::[0-9a-f-]{0,35})?)?)?)?)?$/, "");
  const parts = visible.split(CARD);
  if (parts.length === 1) return <MarkdownText text={visible} />;
  return <>{parts.map((part, index) => index % 2 ? <RecipeCardById key={`${part}-${index}`} id={part} /> : part.trim() ? <MarkdownText key={index} text={part} /> : null)}</>;
}

function MarkdownText({ text }: { text: string }) {
  return <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>{alt || "图片"}</span>,
    table: ({ children }) => <div className={styles.tableScroll} role="region" aria-label="对比表格" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
