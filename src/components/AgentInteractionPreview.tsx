"use client";

import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { CreditCard, House, Plus, Sparkles } from "lucide-react";
import { FloatingAppAgent, type AppAgentTransport } from "./FloatingAppAgent";
import type { ActionResult, AppAgentView, AppPage, PageAction } from "@/lib/app-agent-protocol";
import bank from "./BankingApp.module.css";
import styles from "./AgentInteractionPreview.module.css";

type Scenario = "transfer" | "card";
type Screen = "首页" | "卡片管理" | "申请虚拟卡" | "转账填写" | "核对转账" | "演示完成";

// Deliberately separate from the banking API: this preview exercises the actual
// page executor and assistant UI, with a labelled deterministic task planner.
function createPreviewTransport(scenario: Scenario, setRecords: Dispatch<SetStateAction<string[]>>, epoch: number): AppAgentTransport {
    let run: AppAgentView | null = null;
    let sequence = 0;
    let selectedRecipient = "";
    let editChoice: { target: string; value: string } | null = null;
    let goals: Record<string, string> = { "field-card-name": "旅行备用卡", "field-amount": "200", "field-note": "周末聚餐 AA" };
    const issue = (action: PageAction) => {
      const granted = run!.controlGranted;
      run = { ...run!, steps: ++sequence, pending: { id: `preview-action-${sequence}`, action },
        status: action.type === "question" ? "QUESTION" : action.type === "handoff" ? "HANDOFF" : granted ? "ACTION" : "CONSENT",
        message: action.type === "question" ? action.question : action.description };
      return run;
    };
    const next = (page: AppPage) => {
      if (page.name === "演示完成") {
        run = { ...run!, pending: null, status: "COMPLETED", controlGranted: false, message: "交互演示完成，没有发生银行交易。" };
        return run;
      }
      const control = (id: string) => page.controls.find((item) => item.id === id);
      const click = (target: string, description: string) => issue({ type: "click", target, description, pageVersion: page.version });
      const fill = (target: string, value: string, description: string) => issue({ type: "fill", target, value, description, pageVersion: page.version });
      if (scenario === "card") {
        if (page.name === "首页") return click("nav-cards", "进入卡片管理");
        if (control("open-card-application")) return click("open-card-application", "打开虚拟卡申请表");
        if (control("field-card-name")?.value !== goals["field-card-name"]) return fill("field-card-name", goals["field-card-name"], "填写卡片名称");
        return issue({ type: "handoff", description: "卡片名称已填好，请你核对并确认申请。" });
      }
      if (!selectedRecipient) return issue({ type: "question", question: "这次演示转给谁？", options: ["刘敏 · 尾号 1234", "陈晨 · 尾号 5678"] });
      if (control("open-transfer")) return click("open-transfer", "打开转账页面");
      if (control("confirm-transfer")) return issue({ type: "handoff", description: "信息已准备好，请你本人确认；这里仅模拟交互。" });
      if (control("field-recipient")?.value !== (goals["field-recipient"] ?? selectedRecipient)) return fill("field-recipient", goals["field-recipient"] ?? selectedRecipient, "填写已选择的收款人");
      if (control("field-amount")?.value !== goals["field-amount"]) return fill("field-amount", goals["field-amount"], "填写金额");
      if (control("field-note")?.value !== goals["field-note"]) return fill("field-note", goals["field-note"], "填写转账备注");
      return click("prepare-transfer", "打开核对页面，等待你确认");
    };
    return {
      storageKey: `bankpilot-interaction-preview-run-${epoch}`,
      restore: async (id) => { if (!run || run.id !== id) throw new Error("PREVIEW_RESET"); return run; },
      request: async (body) => {
        if (body.command === "start") {
          selectedRecipient = ""; sequence = 0; editChoice = null;
          goals = { "field-card-name": "旅行备用卡", "field-amount": "200", "field-note": "周末聚餐 AA" };
          run = { id: crypto.randomUUID(), status: "RUNNING", controlGranted: false, pending: null, message: "", steps: 0 };
          setRecords(["预设演示开始"]);
          return next(body.page as AppPage);
        }
        if (!run || run.id !== body.id) throw new Error("请重新开始交互演示");
        if (body.command === "allow") { run = { ...run, controlGranted: true, status: "ACTION" }; setRecords((items) => [...items, "用户允许页面接管"]); return run; }
        if (body.command === "pause") { run = { ...run, status: "PAUSED", message: "你已接管页面，演示助手已暂停。" }; setRecords((items) => [...items, "用户接管，停止未执行动作"]); return run; }
        if (body.command === "cancel") { run = { ...run, status: "CANCELLED", controlGranted: false, pending: null, message: "交互演示已结束。" }; return run; }
        if (body.actionId !== run.pending?.id) throw new Error("演示动作已变化");
        const result = body.result as ActionResult;
        const action = run.pending!.action;
        setRecords((items) => [...items, `${action.type === "question" ? "回答澄清" : action.description} · ${result.status}`]);
        if (body.command === "refresh" && action.type === "fill") {
          const field = result.page.controls.find((item) => item.id === action.target);
          if (field?.value && field.value !== action.value) {
            editChoice = { target: action.target, value: field.value };
            return issue({ type: "question", question: "这个字段已被你修改，继续时怎么处理？", options: [`保留当前：${field.value.slice(0, 60)}`, "按原计划填写"] });
          }
        }
        if (action.type === "question" && result.status === "USER_ANSWERED") {
          if (editChoice) {
            if (result.message !== "按原计划填写") goals[editChoice.target] = result.message.startsWith("保留当前：") ? editChoice.value : result.message.slice(0, 100);
            editChoice = null;
          } else selectedRecipient = result.message.split(" · ")[0].slice(0, 40);
        }
        return next(result.page);
      },
    };
}

export function AgentInteractionPreview() {
  const [scenario, setScenario] = useState<Scenario>("transfer");
  const [epoch, setEpoch] = useState(0);
  const [screen, setScreen] = useState<Screen>("首页");
  const [openSignal, setOpenSignal] = useState(0);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [cardName, setCardName] = useState("");
  const [records, setRecords] = useState<string[]>([]);
  const root = useRef<HTMLElement>(null);
  const transport = useMemo(() => createPreviewTransport(scenario, setRecords, epoch), [scenario, epoch]);

  const reset = (next: Scenario) => {
    setEpoch((value) => value + 1);
    setScenario(next); setScreen("首页"); setRecipient(""); setAmount(""); setNote(""); setCardName(""); setRecords([]); setOpenSignal((value) => value + 1);
  };
  return <div className={styles.layout}>
    <aside className={styles.guide}>
      <span className={styles.badge}>交互验证预览</span><h1>让助手在你眼前操作</h1>
      <p>这里跑预设流程，方便你体验光标、填表、暂停与继续。不调用模型，不连接银行账户，不产生交易。</p>
      <div className={styles.scenarios}><button aria-pressed={scenario === "transfer"} onClick={() => reset("transfer")}>转账填表 · 200 元</button><button aria-pressed={scenario === "card"} onClick={() => reset("card")}>申请虚拟卡</button></div>
      <ol><li>点悬浮助手，输入任意文字开始当前演示。</li><li>选择收款人并允许代操作，观察光标和逐字填写。</li><li>填写中点一下金额或备注，助手会立即暂停。</li><li>修改字段后点“继续”，助手会按新页面处理。</li><li>最后的确认按钮由你点击。</li></ol>
      <small>正式助手入口：<Link href="/">银行 APP</Link>，需要登录和配置真实模型。</small>
      {!!records.length && <details className={styles.records}><summary>演示操作记录 · {records.length} 条</summary><ol>{records.map((record, index) => <li key={index}>{record}</li>)}</ol></details>}
    </aside>
    <main className={bank.stage} ref={root} data-agent-page={screen}>
      <section className={bank.phone} aria-label="BankPilot 交互演示">
        <header className={bank.topbar}><span className={bank.avatar}>体验</span><div className={bank.wordmark}><span>B</span> BankPilot</div><Sparkles size={19} /></header>
        <div className={styles.demoNotice} data-agent-private>预设交互演示 · 无实际交易</div>
        <div className={bank.viewport} data-agent-viewport>
          {screen === "首页" && <div className={bank.home}><section className={bank.balanceBlock}><div className={bank.labelRow}>演示账户</div><div className={bank.balance}>¥5,000.00</div><div className={bank.balanceMeta}>示例余额 · 非真实账户</div></section><div className={bank.quickActions}><button data-agent-id="open-transfer" data-agent-permission="navigate" onClick={() => setScreen("转账填写")}><span><Plus /></span>转账</button></div><p className={styles.pageCopy}>当前体验：{scenario === "transfer" ? "选择收款人，填入 200 元和聚餐备注" : "申请名为“旅行备用卡”的虚拟卡"}</p></div>}
          {screen === "卡片管理" && <div className={bank.listView}><div className={bank.viewHeading}><p>卡片与限额</p><h1>我的卡</h1></div><section className={bank.bankCard}><div><span>B</span><small>VIRTUAL</small></div><strong>日常卡</strong><p>•••• 5678</p><footer><span>演示卡</span><span>日限额 ¥1,000.00</span></footer></section><button data-agent-id="open-card-application" data-agent-permission="navigate" className={bank.outlineAction} onClick={() => setScreen("申请虚拟卡")}><Plus size={18} />申请虚拟卡</button></div>}
          {screen === "转账填写" && <div className={styles.formPage}><p className={bank.eyebrow}>准备转账</p><h1>填写转账信息</h1><form className={bank.actionForm} onSubmit={(event) => { event.preventDefault(); setScreen("核对转账"); }}><label>收款人<input data-agent-id="field-recipient" data-agent-permission="fill" required value={recipient} onChange={(event) => setRecipient(event.target.value)} /></label><label>金额（元）<input data-agent-id="field-amount" data-agent-permission="fill" type="number" min="0.01" step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label>备注<input data-agent-id="field-note" data-agent-permission="fill" value={note} onChange={(event) => setNote(event.target.value)} /></label><button data-agent-id="prepare-transfer" data-agent-permission="prepare" className={bank.primaryButton}>继续核对</button></form></div>}
          {screen === "核对转账" && <div className={styles.formPage}><p className={bank.eyebrow}>由你本人确认</p><h1>核对转账信息</h1><div className={bank.transferReceipt}><strong>¥{Number(amount).toFixed(2)}</strong><dl><div><dt>收款人</dt><dd>{recipient}</dd></div><div><dt>备注</dt><dd>{note}</dd></div></dl></div><button data-agent-id="confirm-transfer" data-agent-permission="human" className={bank.primaryButton} onClick={() => setScreen("演示完成")}>确认演示 · 不转账</button></div>}
          {screen === "申请虚拟卡" && <div className={styles.formPage}><p className={bank.eyebrow}>准备申请</p><h1>申请虚拟卡</h1><form className={bank.actionForm} onSubmit={(event) => { event.preventDefault(); setScreen("演示完成"); }}><label>卡片名称<input data-agent-id="field-card-name" data-agent-permission="fill" value={cardName} onChange={(event) => setCardName(event.target.value)} required /></label><button data-agent-id="confirm-card" data-agent-permission="human" className={bank.primaryButton}>确认演示申请</button></form></div>}
          {screen === "演示完成" && <div className={styles.formPage}><Sparkles size={32} /><h1>演示完成</h1><p>你已完成本人确认。这里没有创建卡片或产生转账。</p></div>}
        </div>
        <nav className={bank.nav} aria-label="演示主导航"><button data-agent-id="nav-home" data-agent-permission="navigate" onClick={() => setScreen("首页")}><House size={21} /><span>首页</span></button><button onClick={() => setOpenSignal((value) => value + 1)}><Sparkles size={21} /><span>AI 助手</span></button><button data-agent-id="nav-cards" data-agent-permission="navigate" onClick={() => setScreen("卡片管理")}><CreditCard size={21} /><span>卡片</span></button></nav>
        <FloatingAppAgent key={`${scenario}-${epoch}`} rootRef={root} configured openSignal={openSignal} transport={transport} />
      </section>
    </main>
  </div>;
}
