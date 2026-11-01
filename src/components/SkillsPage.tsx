"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { bankRequest } from "@/lib/client-request";
import styles from "./SkillsPage.module.css";

type Skill = { skillId: string; name: string; description: string; whenToUse: string; steps: string[]; notes: string[]; status: "DRAFT" | "ACTIVE" | "DISABLED"; version: string };
type BuiltIn = { name: string; description: string };
type Listing = { skills: Skill[]; builtIn: BuiltIn[] };
type Draft = { name: string; description: string; whenToUse: string; steps: string; notes: string };

const STATUS_LABEL = { ACTIVE: "已保存", DISABLED: "已停用", DRAFT: "预览中" } as const;
// 自带做法的内部编号对用户没有意义，这里只给中文名；没有对应名字时才显示编号。
const BUILT_IN_LABEL: Record<string, string> = {
  "bank-insight": "消费洞察", "bank-investments": "理财", "bank-budget": "预算规划", "bank-cross-border": "跨境金融", "bank-branch-services": "本行业务",
  "bank-fraud-guard": "反诈守护", "bank-skill-creator": "做法的创建", "bank-schedules": "定时任务", "bank-feed-cards": "动态卡片", "bank-ui-design": "页面与布局",
  "bank-tools": "交互小工具", "bank-wallet-rules": "立规矩", "bank-daily-review": "每日巡检", "bank-page": "页面办理",
};
const json = (method: "PATCH" | "DELETE", body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
const toDraft = (skill: Skill): Draft => ({ name: skill.name, description: skill.description, whenToUse: skill.whenToUse, steps: skill.steps.join("\n"), notes: skill.notes.join("\n") });

// “我的做法”：用户查看、修改、停用或删除自己保存的做法；Blank 自带的做法只读展示。
// 修改、停用、删除都带着看到的版本号，旧版本不会覆盖新的修改。
export function SkillsPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", description: "", whenToUse: "", steps: "", notes: "" });
  const [busy, setBusy] = useState(false);

  // 挂载时读取一次：setState 只出现在异步回调里，卸载后不再更新。
  useEffect(() => {
    let alive = true;
    bankRequest<Listing>("/api/v1/skills", { cache: "no-store" })
      .then(result => { if (alive) setListing(result); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "暂时无法读取。"); });
    return () => { alive = false; };
  }, []);
  const reload = () => bankRequest<Listing>("/api/v1/skills", { cache: "no-store" })
    .then(result => setListing(result))
    .catch(() => undefined);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setEditing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时无法完成，请稍后再试。");
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const url = (skill: Skill) => `/api/v1/skills/${encodeURIComponent(skill.skillId)}`;
  const toggle = (skill: Skill) => run(() => bankRequest(url(skill), json("PATCH", { version: skill.version, enabled: skill.status !== "ACTIVE" })));
  const save = (skill: Skill) => run(() => bankRequest(url(skill), json("PATCH", {
    version: skill.version, name: draft.name, description: draft.description, whenToUse: draft.whenToUse, steps: lines(draft.steps), notes: lines(draft.notes),
  })));
  const remove = (skill: Skill) => run(() => bankRequest(url(skill), json("DELETE", { version: skill.version })));

  return <main className={styles.page}>
    <header><Link href="/">← 返回</Link></header>
    <h1>我的做法</h1>
    <p className={styles.muted}>做法是你亲口教给 Blank 的办事步骤，以后说一句话就能触发。在对话里说“记成一个做法”就能保存新的。做法只是说明书：只能组合现有工具，不能免确认或新增权限，动钱照样走确认。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}

    <h2>你保存的做法</h2>
    {listing === null ? <p className={styles.muted}>正在读取…</p>
      : !listing.skills.length ? <p className={styles.muted}>还没有保存的做法。可以对 Blank 说“以后我出差回来，帮我把报销要用的流水整理出来，记成一个做法”试试。</p>
        : <ul className={styles.list}>{listing.skills.map(skill => <li key={skill.skillId}>
          <header><strong>{skill.name}</strong><span className={styles.tag}>{STATUS_LABEL[skill.status]}</span></header>
          {editing === skill.skillId ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(skill); }}>
            <input aria-label="名字" maxLength={12} value={draft.name} disabled={busy} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
            <input aria-label="简介" maxLength={80} value={draft.description} disabled={busy} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} />
            <textarea aria-label="什么时候用" maxLength={160} value={draft.whenToUse} disabled={busy} onChange={event => setDraft(current => ({ ...current, whenToUse: event.target.value }))} />
            <textarea aria-label="怎么做（每行一步）" value={draft.steps} disabled={busy} onChange={event => setDraft(current => ({ ...current, steps: event.target.value }))} />
            <textarea aria-label="注意事项（每行一条）" value={draft.notes} disabled={busy} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))} />
            <div className={styles.actions}>
              <button type="submit" className={styles.primary} disabled={busy}>保存</button>
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
            </div>
          </form>
            : <>
              <p>{skill.description}</p>
              <ol className={styles.steps}>{skill.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
              <div className={styles.actions}>
                <button type="button" disabled={busy} onClick={() => { setEditing(skill.skillId); setDraft(toDraft(skill)); }}>修改</button>
                <button type="button" disabled={busy} onClick={() => void toggle(skill)}>{skill.status === "ACTIVE" ? "停用" : "启用"}</button>
                <button type="button" className={styles.delete} disabled={busy} onClick={() => void remove(skill)}>删除</button>
              </div>
            </>}
        </li>)}</ul>}

    <h2>Blank 自带的做法</h2>
    <p className={styles.muted}>这些做法随 Blank 一起提供，不能修改。</p>
    <ul className={styles.list}>{listing?.builtIn.map(item => <li key={item.name}>
      <header><strong>{BUILT_IN_LABEL[item.name] ?? item.name}</strong></header>
      <p>{item.description}</p>
    </li>)}</ul>
  </main>;
}
