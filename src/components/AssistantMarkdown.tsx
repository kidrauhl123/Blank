"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./AssistantMarkdown.module.css";

export function AssistantMarkdown({ text }: { text: string }) {
  return <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>{alt || "图片"}</span>,
    table: ({ children }) => <div className={styles.tableScroll} role="region" aria-label="对比表格" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
