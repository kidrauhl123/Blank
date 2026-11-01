"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { bankRequest } from "@/lib/client-request";
import styles from "./SkillCard.module.css";

type Skill = { skillId: string; name: string; description: string; whenToUse: string; steps: string[]; notes: string[]; status: "DRAFT" | "ACTIVE" | "DISABLED" };
const STATUS_LABEL = { DRAFT: "预览中，还没保存", ACTIVE: "已保存", DISABLED: "已停用" } as const;

// 对话里的 [[skill:编号]]：做法的预览卡片。预览和已保存的做法都从服务端读取，模型文本里的内容不作为依据。
export function SkillCardById({ id }: { id: string }) {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    bankRequest<{ skill: Skill }>(`/api/v1/skills/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(result => { if (alive) setSkill(result.skill); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [id]);
  if (failed) return <p className={styles.muted}>这个做法暂时无法显示。</p>;
  if (!skill) return <p className={styles.muted}>正在读取做法…</p>;
  return <section className={styles.card} aria-label="做法预览">
    <header><strong>{skill.name}</strong><span className={styles.tag}>{STATUS_LABEL[skill.status]}</span></header>
    <p>{skill.description}</p>
    <h4>什么时候用</h4>
    <p>{skill.whenToUse}</p>
    <h4>怎么做</h4>
    <ol>{skill.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
    {skill.notes.length > 0 && <>
      <h4>注意事项</h4>
      <ul>{skill.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
    </>}
    <p className={styles.boundary}>做法只能组合现有工具，不新增权限；动钱照样走确认。</p>
    <Link href="/skills">在「我的做法」里修改或停用</Link>
  </section>;
}
