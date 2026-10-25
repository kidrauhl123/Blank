"use client";

import {
  ArrowUpRight, ChartNoAxesColumnIncreasing,
  ChevronRight, Clock3, CreditCard, Eye, EyeOff, House, Link2,
  LogOut, Plus, RefreshCw, Settings, ShieldCheck, TrendingUp,
} from "lucide-react";
import { FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { ServiceWorkerRegister } from "./ServiceWorkerRegister";
import { AuthScreen } from "./AuthScreen";
import { FloatingAppAgent } from "./FloatingAppAgent";
import { LiquidBankCard } from "./LiquidBankCard";
import { TransactionCategoryIcon } from "./TransactionCategoryIcon";
import { BankDialog as ModalShell } from "./BankDialog";
import { InvestmentView } from "./InvestmentView";
import { AssistantMark } from "./AssistantMark";
import { InvestmentReceiptDialog } from "./InvestmentReceiptDialog";
import { ProactiveAttention } from "./ProactiveAttention";
import type { InvestmentReceipt } from "@/lib/investment-types";
import type { BankStatement } from "@/lib/banking-report";
import { bankRequest, BankRequestError, jsonPost } from "@/lib/client-request";
import styles from "./BankingApp.module.css";

type Account = { id: string; name: string; account_no: string; masked_no: string; account_type: string; available_balance_minor: string; currency: string; status: string };
type Transaction = { id: string; merchant_name: string; category: string; amount_minor: string; occurred_at: string; is_anomaly: boolean; investment_receipt?: InvestmentReceipt | null };
type Card = { id: string; card_name: string; masked_no: string; card_type: string; status: string; daily_limit_minor: string };
type Bootstrap = { customer: { display_name: string; phone: string; mfa_configured: boolean }; totalMinor: number; accounts: Account[]; transactions: Transaction[]; cards: Card[]; statement: BankStatement; ai: { configured: boolean; model: string | null }; features?: { proactiveReviews: boolean; voiceCalls?: boolean } };
type Tab = "home" | "activity" | "cards" | "wealth";

const money = (minor: number | string) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(minor) / 100);
const shortDate = (date: string) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date(date));
type PreparedTransfer = {
  operationId: string; riskLevel: "YELLOW" | "RED"; requiredAuth: "CONFIRM" | "MFA";
  taskId?: string;
  status?: string;
  details: { amountMinor: number; sourceAccount: { name: string; maskedNo: string }; recipient: { name: string; phoneMasked: string; maskedAccount: string }; note?: string | null };
};

export function BankingApp() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [balanceVisible, setBalanceVisible] = useState(true);
  const [mfaCode, setMfaCode] = useState("");
  const [dialog, setDialog] = useState<"deposit" | "transfer" | "card" | "profile" | "card-details" | null>(null);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(0);
  const [assistantClose, setAssistantClose] = useState(0);
  const [assistantVisible, setAssistantVisible] = useState(false);
  const appRoot = useRef<HTMLElement>(null);
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const authorizationLoaded = useRef(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (generation !== loadGeneration.current) return false;
      if (response.status === 401) { setAuthRequired(true); setData(null); setError(""); return false; }
      if (!response.ok) throw new Error("load");
      const result = await response.json();
      if (generation !== loadGeneration.current) return false;
      setData(result); setAuthRequired(false); setError("");
      return true;
    } catch {
      if (generation === loadGeneration.current) { setData(null); setError("账户数据暂时无法读取。请刷新后再办理业务。"); }
      return false;
    } finally { if (generation === loadGeneration.current) setLoading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { viewportRef.current?.scrollTo({ top: 0 }); }, [tab]);
  useEffect(() => {
    if (!data || authorizationLoaded.current) return;
    const params = new URLSearchParams(location.search);
    const operationId = params.get("authorize");
    const taskId = params.get("task");
    if (!operationId) return;
    authorizationLoaded.current = true;
    fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`).then(async response => {
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      if (result.status === "AWAITING_AUTH") { setPrepared({ ...result, taskId: taskId ?? undefined }); setDialog("transfer"); }
      else setNotice("这笔操作已不在待确认状态，请在明细中核对结果。");
    }).catch(reason => setError(reason instanceof Error ? reason.message : "无法读取待确认操作，请重新打开链接。"));
  }, [data]);

  const navigate = (next: Tab) => { setTab(next); setAssistantClose(value => value + 1); };
  const openAssistant = () => setAssistantOpen(value => value + 1);
  const closeTransfer = () => { setDialog(null); setPrepared(null); setMfaCode(""); if (location.search) history.replaceState(null, "", location.pathname); };
  const afterAction = async (message: string, next?: Tab) => {
    closeTransfer(); setNotice(message); if (next) setTab(next); await load();
  };
  const logout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout");
      loadGeneration.current++;
      sessionStorage.removeItem("bankpilot-app-agent-run");
      setData(null); setDialog(null); setPrepared(null); setMfaCode(""); setSelectedCard(null); setTab("home"); setError(""); setNotice(""); setAssistantVisible(false);
      authorizationLoaded.current = false;
      if (location.search) history.replaceState(null, "", location.pathname);
      setAuthRequired(true);
    } catch { setError("退出未完成，请重试。"); } finally { setLogoutBusy(false); }
  };

  if (loading && !data && !authRequired) return <main className={styles.stage}><div className={styles.splash} role="status"><span>B</span><p>正在读取账户信息…</p></div></main>;
  if (authRequired) return <AuthScreen onAuthenticated={async () => { await load(); }} />;
  if (!data) return <main className={styles.stage}><section className={styles.unavailable}><ShieldCheck size={32} /><h1>账户数据暂不可用</h1><p role="alert">{error || "请重新读取账户信息。"}</p>{notice && <p className={styles.confirmedNotice} role="status">{notice} 请刷新查看最新账户状态。</p>}<button className={styles.primaryButton} disabled={loading} onClick={() => void load()}><RefreshCw size={17} />重新读取</button><small>读取失败不代表余额为零。操作结果请以回执和最新明细为准。</small></section></main>;
  const account = data.accounts[0];

  return <main className={styles.stage} ref={appRoot} data-agent-page={dialog ?? ({ home: "首页", activity: "账户明细", cards: "卡片管理", wealth: "理财" }[tab])}>
    <ServiceWorkerRegister />
    <section className={styles.phone} aria-label="BankPilot 手机银行">
      <header className={styles.topbar} inert={assistantVisible}>
        <button className={styles.avatar} aria-label="个人中心" onClick={() => setDialog("profile")}>{data.customer.display_name.slice(0, 2).toUpperCase()}</button>
        <div className={styles.wordmark}><span>B</span> BankPilot</div>
        <a className={styles.iconButton} href="/security" aria-label="安全中心"><ShieldCheck size={21} strokeWidth={1.8} /></a>
      </header>
      {error && <div className={styles.connectionError} role="alert"><span>{error}</span><button disabled={loading} onClick={() => void load()}><RefreshCw size={15} />重新读取</button></div>}
      {notice && <div className={styles.confirmedNotice} role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭操作提示">关闭</button></div>}
      {loading && <p className={styles.refreshStatus} role="note">正在更新账户信息，以下为上次读取的数据…</p>}
      <div className={styles.viewport} ref={viewportRef} data-agent-viewport inert={assistantVisible}>
        {tab === "home" && <HomeView data={data} loading={loading} visible={balanceVisible} toggleVisible={() => setBalanceVisible(!balanceVisible)} onDeposit={() => setDialog("deposit")} onTransfer={() => setDialog("transfer")} />}
        {tab === "activity" && <ActivityView data={data} />}
        {tab === "cards" && <CardsView data={data} disabled={loading} onCreate={() => setDialog("card")} onSelect={id => { setSelectedCard(id); setDialog("card-details"); }} />}
        {tab === "wealth" && <InvestmentView accounts={data.accounts} mfaConfigured={data.customer.mfa_configured} onChanged={async message => { if (message) setNotice(message); await load(); }} />}
      </div>
      <nav className={styles.nav} aria-label="主导航">
        <NavButton agentId="nav-home" active={tab === "home" && !assistantVisible} label="首页" icon={<House size={21} />} onClick={() => navigate("home")} />
        <NavButton agentId="nav-wealth" active={tab === "wealth" && !assistantVisible} label="理财" icon={<TrendingUp size={21} />} onClick={() => navigate("wealth")} />
        <NavButton active={assistantVisible} label="AI 助手" icon={<AssistantMark />} onClick={openAssistant} />
        <NavButton agentId="nav-activity" active={tab === "activity" && !assistantVisible} label="明细" icon={<ChartNoAxesColumnIncreasing size={21} />} onClick={() => navigate("activity")} />
        <NavButton agentId="nav-cards" active={tab === "cards" && !assistantVisible} label="卡片" icon={<CreditCard size={21} />} onClick={() => navigate("cards")} />
      </nav>
      <FloatingAppAgent rootRef={appRoot} configured={data.ai.configured} voiceEnabled={data.features?.voiceCalls} openSignal={assistantOpen} closeSignal={assistantClose} onOpenChange={setAssistantVisible} presentation="page" />
    </section>
    {dialog === "deposit" && account && <DepositModal account={account} busy={actionBusy} close={() => setDialog(null)} done={() => afterAction("入金已完成。")} setBusy={setActionBusy} />}
    {dialog === "transfer" && account && <TransferModal account={account} mfaConfigured={data.customer.mfa_configured} prepared={prepared} setPrepared={setPrepared} busy={actionBusy} setBusy={setActionBusy} close={closeTransfer} code={mfaCode} setCode={setMfaCode} done={() => afterAction("转账已完成，请在明细中查看回执。")} />}
    {dialog === "card" && account && <CardModal account={account} busy={actionBusy} setBusy={setActionBusy} close={() => setDialog(null)} done={() => afterAction("虚拟卡已申请成功。", "cards")} />}
    {dialog === "profile" && <ProfileModal data={data} busy={logoutBusy} close={() => setDialog(null)} logout={logout} />}
    {dialog === "card-details" && <CardDetailsModal card={data.cards.find(card => card.id === selectedCard)} close={() => setDialog(null)} done={() => afterAction("卡片已锁定。")} />}
  </main>;
}

function NavButton({ active, label, icon, onClick, agentId }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void; agentId?: string }) {
  return <button data-agent-id={agentId} data-agent-permission="navigate" aria-current={active ? "page" : undefined} className={active ? styles.navActive : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function HomeView({ data, loading, visible, toggleVisible, onDeposit, onTransfer }: { data: Bootstrap; loading: boolean; visible: boolean; toggleVisible: () => void; onDeposit: () => void; onTransfer: () => void }) {
  const categories = data?.statement.categories.slice(0, 3) ?? [];
  return <div className={styles.home}>
    <div className={styles.homeGreeting}><div><h1>你好，{data?.customer.display_name ?? "欢迎回来"}</h1></div><span>账户总览</span></div>
    <section className={styles.balanceBlock} aria-label="账户资产总览"><div className={styles.labelRow}><span>总资产 · CNY</span><button onClick={toggleVisible} aria-label={visible ? "隐藏余额" : "显示余额"} aria-pressed={!visible}>{visible ? <Eye size={18} /> : <EyeOff size={18} />}</button></div><div className={styles.balance}>{visible ? money(data.totalMinor) : "••••••"}</div><div className={styles.balanceMeta}><span>{loading ? "上次读取的账户资产" : "账户资产"}</span><span>{data.accounts[0]?.masked_no ?? "暂无可用账户"}</span></div>
    <div className={styles.quickActions}>
      <button data-agent-id="open-transfer" data-agent-permission="navigate" className={styles.primary} disabled={loading || !data.accounts[0]} onClick={onTransfer}><span><ArrowUpRight /></span>转账</button>
      <button data-agent-id="open-deposit" data-agent-permission="navigate" disabled={loading || !data.accounts[0]} onClick={onDeposit}><span><Plus /></span>入金</button>
    </div>
    </section>
    {data.features?.proactiveReviews && <ProactiveAttention key={data.customer.phone} />}
    <section className={styles.section}><div className={styles.sectionHead}><div><p>本月支出与转出</p><h2>{data ? money(data.statement.expenseMinor) : "—"}</h2></div><span className={styles.monthLabel}>{data?.statement.month ?? "本月"}</span></div>{categories.length > 0 && <div className={styles.spendingBreakdown}>{categories.map((category) => <div key={category.category}><span>{category.category}</span><b>{money(category.totalMinor)}</b></div>)}</div>}{data?.statement.expenseMinor === 0 && <p className={styles.emptyCopy}>本月还没有支出记录。</p>}</section>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>最近交易</h2><span>{data?.transactions.length ?? 0} 笔</span></div><TransactionList items={data?.transactions.slice(0, 4) ?? []} /></section>
  </div>;
}

function TransactionList({ items }: { items: Transaction[] }) {
  const [selected, setSelected] = useState<Transaction | null>(null);
  if (!items.length) return <div className={styles.emptyState}><span>还没有交易</span><small>入金或转账后会显示在这里。</small></div>;
  return <><div className={styles.transactionList}>{items.map((item) => {
    const content = <>
    <span className={Number(item.amount_minor) >= 0 ? styles.txIconIn : styles.txIcon}><TransactionCategoryIcon category={item.category} merchant={item.merchant_name} incoming={Number(item.amount_minor) >= 0} /></span>
    <span className={styles.txCopy}><b>{item.merchant_name}</b><small>{item.category} · {shortDate(item.occurred_at)}{item.investment_receipt && " · 查看回执"}{item.is_anomaly && <em>需核实</em>}</small></span>
    <strong className={Number(item.amount_minor) >= 0 ? styles.positive : ""}>{Number(item.amount_minor) >= 0 ? "+" : "−"}{money(Math.abs(Number(item.amount_minor)))}</strong>
    </>;
    return item.investment_receipt
      ? <button key={item.id} className={`${styles.transaction} ${styles.transactionButton}`} data-agent-id={`transaction-${item.id}`} data-agent-permission="navigate" aria-label={`查看${item.merchant_name}回执`} onClick={() => setSelected(item)}>{content}</button>
      : <div className={styles.transaction} key={item.id}>{content}</div>;
  })}</div>{selected?.investment_receipt && <InvestmentReceiptDialog receipt={selected.investment_receipt} postedAt={selected.occurred_at} close={() => setSelected(null)} />}</>;
}

function ActivityView({ data }: { data: Bootstrap | null }) {
  const [filter, setFilter] = useState("全部");
  const items = (data?.transactions ?? []).filter((item) => filter === "全部" || (filter === "支出" && Number(item.amount_minor) < 0) || (filter === "收入" && Number(item.amount_minor) > 0) || (filter === "异常" && item.is_anomaly));
  return <div className={styles.listView}><div className={styles.viewHeading}><p>最近 50 笔交易</p><h1>账户活动</h1></div><div className={styles.filterPills}>{["全部", "支出", "收入", "异常"].map((label) => <button data-agent-id={`filter-${label}`} data-agent-permission="navigate" key={label} aria-pressed={filter === label} className={filter === label ? styles.selected : undefined} onClick={() => setFilter(label)}>{label}</button>)}</div><section className={styles.section}>{items.length ? <TransactionList items={items} /> : <p className={styles.emptyCopy}>没有符合条件的交易。</p>}</section></div>;
}

function useWriteFeedback(setBusy: (value: boolean) => void) {
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await work(); pending.current = false; }
    catch (reason) {
      const unknown = !(reason instanceof BankRequestError) || reason.outcomeUnknown;
      setError(reason instanceof BankRequestError ? reason.message : "暂时无法确认操作结果，请先查看最新明细或卡片状态。");
      setUncertain(unknown); pending.current = unknown;
    } finally { setBusy(false); }
  };
  return { error, uncertain, run };
}

function DepositModal({ account, busy, setBusy, close, done }: { account: Account; busy: boolean; setBusy: (value: boolean) => void; close: () => void; done: () => Promise<void> }) {
  const { error, uncertain, run } = useWriteFeedback(setBusy);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await run(async () => { await bankRequest("/api/v1/deposits", jsonPost({ accountId: account.id, amountMinor: Math.round(Number(values.get("amount")) * 100), source: values.get("source"), reference: values.get("reference") })); await done(); });
  };
  return <ModalShell eyebrow="请核对金额" title="向账户入金" close={close} busy={busy}><p>确认后，金额将计入你的账户。</p><form className={styles.actionForm} onSubmit={submit}>
    <label>金额（元）<input disabled={busy || uncertain} data-agent-id="field-amount" data-agent-permission="fill" name="amount" type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" required autoFocus /></label>
    <label>资金来源<select disabled={busy || uncertain} data-agent-id="field-source" data-agent-permission="fill" name="source"><option value="EXTERNAL_TRANSFER">外部账户转入</option><option value="CASH">现金存入</option></select></label>
    <label>外部参考号（选填）<input disabled={busy || uncertain} data-agent-id="field-reference" data-agent-permission="fill" name="reference" maxLength={80} /></label>{error && <div role="alert" className={styles.formError}>{error}</div>}
    <button data-agent-id="confirm-deposit" data-agent-permission="human" className={styles.primaryButton} disabled={busy || uncertain}>{busy ? "正在处理…" : "确认入金"}</button>
  </form>{uncertain && <button type="button" className={styles.textAction} onClick={() => window.location.reload()}>重新读取账户状态</button>}</ModalShell>;
}

function TransferModal({ account, mfaConfigured, prepared, setPrepared, busy, setBusy, close, code, setCode, done }: { account: Account; mfaConfigured: boolean; prepared: PreparedTransfer | null; setPrepared: (value: PreparedTransfer | null) => void; busy: boolean; setBusy: (value: boolean) => void; close: () => void; code: string; setCode: (value: string) => void; done: () => Promise<void> }) {
  const { error, uncertain, run } = useWriteFeedback(setBusy);
  const prepare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await run(async () => { setPrepared(await bankRequest<PreparedTransfer>("/api/v1/transfers/prepare", jsonPost({ fromAccountId: account.id, recipient: values.get("recipient"), amountMinor: Math.round(Number(values.get("amount")) * 100), note: values.get("note") }))); });
  };
  const authorize = async () => {
    if (!prepared) return;
    await run(async () => {
      try { await bankRequest(
        prepared.taskId ? `/api/operations/${prepared.operationId}/commit` : `/api/v1/operations/${prepared.operationId}/authorize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prepared.taskId
            ? { confirmed: true, totpCode: prepared.requiredAuth === "MFA" ? code : undefined, taskId: prepared.taskId, type: "TRANSFER" }
            : { totpCode: prepared.requiredAuth === "MFA" ? code : undefined }),
        },
      ); } catch (reason) {
        if (reason instanceof BankRequestError && reason.code === "AUTH_REQUIRED") {
          try {
            const updated = await bankRequest<PreparedTransfer>(`/api/v1/operations/${encodeURIComponent(prepared.operationId)}`);
            if (updated.operationId !== prepared.operationId || updated.status !== "AWAITING_AUTH" || updated.requiredAuth !== "MFA" || updated.riskLevel !== "RED") {
              throw new Error("Unexpected authorization state");
            }
            setPrepared({ ...updated, taskId: prepared.taskId }); setCode("");
          } catch {
            throw new BankRequestError("风险已升级，但无法读取最新授权状态。请重新读取账户后再办理。", true);
          }
        }
        throw reason;
      }
      await done();
    });
  };
  return <ModalShell eyebrow={prepared ? `${prepared.riskLevel === "RED" ? "红色风险" : "黄色风险"} · ${prepared.requiredAuth === "MFA" ? "强验证" : "用户确认"}` : "先核对，再执行"} title={prepared ? "核对转账" : "发起转账"} close={close} busy={busy}>{!prepared ? <><p>输入收款人的姓名或完整手机号。</p><form className={styles.actionForm} onSubmit={prepare}>
    <label>收款人<input disabled={busy || uncertain} data-agent-id="field-recipient" data-agent-permission="fill" name="recipient" required minLength={2} placeholder="姓名或完整手机号" autoFocus /></label><label>金额（元）<input disabled={busy || uncertain} data-agent-id="field-amount" data-agent-permission="fill" name="amount" type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" required /></label><label>备注（选填）<input disabled={busy || uncertain} data-agent-id="field-note" data-agent-permission="fill" name="note" maxLength={80} /></label>{error && <div role="alert" className={styles.formError}>{error}</div>}<button data-agent-id="prepare-transfer" data-agent-permission="prepare" className={styles.primaryButton} disabled={busy || uncertain}>{busy ? "正在核验…" : "继续核对"}</button>
  </form></> : <><div className={styles.transferReceipt}><strong>{money(prepared.details.amountMinor)}</strong><dl><div><dt>收款人</dt><dd>{prepared.details.recipient.name}</dd></div><div><dt>手机号</dt><dd>{prepared.details.recipient.phoneMasked}</dd></div><div><dt>付款账户</dt><dd>{prepared.details.sourceAccount.maskedNo}</dd></div><div><dt>操作编号</dt><dd>{prepared.operationId}</dd></div></dl></div>{prepared.requiredAuth === "MFA" && (mfaConfigured ? <label className={styles.reauthField}>验证器动态码<input disabled={busy || uncertain} data-agent-private inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位动态验证码" autoComplete="one-time-code" autoFocus /></label> : <div className={styles.mfaRequired}><b>需要先启用多因素认证</b><span>为保护账户，请使用身份验证器生成的动态码。</span><a href="/security">前往安全中心设置</a></div>)}{error && <div role="alert" className={styles.formError}>{error}</div>}<button data-agent-id="confirm-transfer" data-agent-permission="human" className={styles.primaryButton} disabled={busy || uncertain || (prepared.requiredAuth === "MFA" && (!mfaConfigured || code.length !== 6))} onClick={authorize}>{busy ? "正在转账…" : "确认转账"}</button><small>核对收款人和金额后再确认，完成后可在明细中查看结果。</small></>}{uncertain && <button type="button" className={styles.textAction} onClick={() => window.location.reload()}>重新读取账户状态</button>}</ModalShell>;
}

function CardModal({ account, busy, setBusy, close, done }: { account: Account; busy: boolean; setBusy: (value: boolean) => void; close: () => void; done: () => Promise<void> }) {
  const { error, uncertain, run } = useWriteFeedback(setBusy);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const values = new FormData(event.currentTarget); await run(async () => { await bankRequest("/api/v1/cards", jsonPost({ accountId: account.id, cardName: values.get("cardName") })); await done(); }); };
  return <ModalShell eyebrow="确认申请 · 独立支付限额" title="申请虚拟卡" close={close} busy={busy}><p>虚拟卡绑定你的活期账户，默认日限额为 ¥1,000。系统只保存脱敏卡号。</p><form className={styles.actionForm} onSubmit={submit}><label>卡片名称<input disabled={busy || uncertain} data-agent-id="field-card-name" data-agent-permission="fill" name="cardName" defaultValue="日常虚拟卡" required minLength={2} maxLength={30} autoFocus /></label>{error && <div role="alert" className={styles.formError}>{error}</div>}<button data-agent-id="confirm-card" data-agent-permission="human" className={styles.primaryButton} disabled={busy || uncertain}>{busy ? "正在开卡…" : "确认申请"}</button></form>{uncertain && <button type="button" className={styles.textAction} onClick={() => window.location.reload()}>重新读取卡片状态</button>}</ModalShell>;
}

function ProfileModal({ data, busy, close, logout }: { data: Bootstrap; busy: boolean; close: () => void; logout: () => Promise<void> }) {
  return <ModalShell eyebrow="账户" title={data.customer.display_name} close={close} busy={busy}><div className={styles.profileRows} data-agent-private><div><span>手机号</span><b>{data.customer.phone}</b></div><div><span>收款方式</span><b>姓名或手机号</b></div><div><span>账户号</span><b>{data.accounts[0]?.account_no ?? "—"}</b></div></div><a className={styles.developerLink} href="/security"><ShieldCheck size={17} /><span><b>安全中心</b><small>{data.customer.mfa_configured ? "强验证已开启" : "设置高风险操作验证"}</small></span><ChevronRight size={17} /></a><a className={styles.developerLink} href="/schedules"><Clock3 size={17} /><span><b>定时任务</b><small>提醒、账单报告与订阅检查</small></span><ChevronRight size={17} /></a><a className={styles.developerLink} href="/channels"><Link2 size={17} /><span><b>消息渠道</b><small>QQ 与企业微信</small></span><ChevronRight size={17} /></a><a className={styles.developerLink} href="/settings"><Settings size={17} /><span><b>设置</b><small>回复偏好与调试选项</small></span><ChevronRight size={17} /></a><a className={styles.developerLink} href="/audit"><ShieldCheck size={17} /><span><b>操作记录</b><small>风险等级、执行链路与系统状态</small></span><ChevronRight size={17} /></a><button className={styles.logoutButton} disabled={busy} onClick={logout}><LogOut size={17} />{busy ? "正在退出…" : "切换用户"}</button></ModalShell>;
}

function CardDetailsModal({ card, close, done }: { card?: Card; close: () => void; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const { error, uncertain, run } = useWriteFeedback(setBusy);
  const lock = async () => {
    if (!card) return;
    await run(async () => { await bankRequest(`/api/v1/cards/${card.id}/lock`, jsonPost({})); await done(); });
  };
  return <ModalShell title="卡片管理" eyebrow="确认后暂停卡片交易" close={close} busy={busy}>
    {!card ? <p>该卡片当前不可用，请刷新。</p> : <><p><b>{card.card_name} {card.masked_no}</b></p>
      <p>当前状态：{card.status === "ACTIVE" ? "可用" : card.status === "LOCKED" ? "已锁定" : card.status}。</p>
      <p>锁定后暂停使用该卡。真正挂失与解挂暂未开放，锁卡不代表挂失。</p>
      {error && <div role="alert" className={styles.formError}>{error}</div>}
      {card.status === "ACTIVE" && <button data-agent-id="confirm-card-lock" data-agent-permission="human" className={styles.primaryButton} disabled={busy || uncertain} onClick={lock}>{busy ? "正在锁定…" : "确认锁定这张卡"}</button>}
    </>}
    {uncertain && <button type="button" className={styles.textAction} onClick={() => window.location.reload()}>重新读取卡片状态</button>}
  </ModalShell>;
}

function CardsView({ data, disabled, onCreate, onSelect }: { data: Bootstrap; disabled: boolean; onCreate: () => void; onSelect: (id: string) => void }) {
  const [activeId, setActiveId] = useState(data.cards[0]?.id);
  const activeIdRef = useRef(data.cards[0]?.id);
  const carouselRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; started: boolean } | null>(null);
  const cardOrder = data.cards.map(card => card.id).join(",");
  const activeIndex = Math.max(0, data.cards.findIndex(card => card.id === activeId));
  const activeCard = data.cards[activeIndex];

  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;
    const align = () => {
      if (dragRef.current?.started) return;
      const slides = Array.from(carousel.children) as HTMLElement[];
      const current = slides.find(slide => slide.dataset.cardId === activeIdRef.current) ?? slides[0];
      if (current) carousel.scrollTo({ left: current.offsetLeft - slides[0].offsetLeft, behavior: "instant" });
    };
    const observer = new ResizeObserver(align);
    observer.observe(carousel);
    align();
    return () => observer.disconnect();
  }, [cardOrder]);

  const nearestIndex = (carousel: HTMLDivElement) => {
    const slides = Array.from(carousel.children) as HTMLElement[];
    return slides.reduce((nearest, slide, index) =>
      Math.abs(slide.offsetLeft - slides[0].offsetLeft - carousel.scrollLeft) < Math.abs(slides[nearest].offsetLeft - slides[0].offsetLeft - carousel.scrollLeft) ? index : nearest, 0);
  };
  const selectCard = (index: number) => {
    const carousel = carouselRef.current;
    const card = data.cards[index];
    if (!carousel || !card) return;
    activeIdRef.current = card.id;
    setActiveId(card.id);
    const slides = Array.from(carousel.children) as HTMLElement[];
    carousel.scrollTo({ left: slides[index].offsetLeft - slides[0].offsetLeft, behavior: "instant" });
  };
  const syncSelection = (carousel: HTMLDivElement) => {
    const card = data.cards[nearestIndex(carousel)];
    if (card) { activeIdRef.current = card.id; setActiveId(card.id); }
  };
  const dragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, started: false };
  };
  const dragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.started) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { dragRef.current = null; return; }
      drag.started = true;
      event.currentTarget.setAttribute("data-dragging", "true");
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.left - dx;
  };
  const dragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const index = nearestIndex(event.currentTarget);
    event.currentTarget.removeAttribute("data-dragging");
    if (drag.started) selectCard(index);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className={styles.listView}>
    <div className={styles.viewHeading}><p>卡片与限额</p><h1>我的卡<span className={styles.cardCount}>{data.cards.length}</span></h1></div>
    {!data.cards.length && <div className={styles.largeEmpty}><CreditCard size={28} /><b>还没有卡片</b><span>申请一张虚拟卡，为日常支付设置独立限额。</span></div>}
    {activeCard && <>
    <div ref={carouselRef} className={styles.cardCarousel} role="region" aria-roledescription="轮播" aria-label="银行卡" tabIndex={0}
      onScroll={event => syncSelection(event.currentTarget)} onPointerDown={dragStart} onPointerMove={dragMove}
      onPointerUp={dragEnd} onPointerCancel={dragEnd} onLostPointerCapture={dragEnd}
      onPointerLeave={event => { if (!dragRef.current?.started) dragEnd(event); }}
      onKeyDown={event => {
        const next = event.key === "ArrowRight" ? activeIndex + 1 : event.key === "ArrowLeft" ? activeIndex - 1 : event.key === "Home" ? 0 : event.key === "End" ? data.cards.length - 1 : null;
        if (next !== null) { event.preventDefault(); selectCard(Math.max(0, Math.min(data.cards.length - 1, next))); }
      }}>
    {data.cards.map((card, index) => <article className={styles.cardItem} key={card.id} data-card-id={card.id} role="group" aria-roledescription="幻灯片" aria-label={`${index + 1} / ${data.cards.length}，${card.card_name}`}>
      <LiquidBankCard className={styles.bankCard} light={index % 2 === 1} locked={card.status !== "ACTIVE"}>
        <div className={styles.cardBrand}><span className={styles.cardLogo}>B</span><b>BankPilot</b><small>{card.card_type === "VIRTUAL" ? "VIRTUAL" : "DEBIT"}</small></div>
        <div className={styles.cardChip} aria-hidden="true"><i /><i /><i /></div>
        <p className={styles.cardNumber}>{card.masked_no}</p>
        <footer className={styles.cardFooter}><strong>{card.card_name}</strong><span className={styles.cardStatus} data-active={card.status === "ACTIVE"}>{card.status === "ACTIVE" ? "可用" : card.status === "LOCKED" ? "已锁定" : card.status}</span></footer>
      </LiquidBankCard>
    </article>)}
    </div>
    {data.cards.length > 1 && <div className={styles.cardPagination}>
      <div className={styles.cardDots} role="group" aria-label="选择银行卡">{data.cards.map((card, index) => <button key={card.id} type="button"
        data-agent-id={`select-card-${card.id}`} data-agent-permission="navigate" aria-label={`切换到${card.card_name} ${card.masked_no}`}
        aria-pressed={index === activeIndex} onClick={() => selectCard(index)}><span aria-hidden="true" /></button>)}</div>
      <span className={styles.cardPosition} role="status" aria-label={`第 ${activeIndex + 1} 张，共 ${data.cards.length} 张卡`}>{activeIndex + 1} / {data.cards.length}</span>
    </div>}
    <div className={styles.cardControls}><span>日限额<b>{money(activeCard.daily_limit_minor)}</b></span>
      <button data-agent-id={`view-card-${activeCard.id}`} data-agent-permission="navigate" data-agent-label={`管理 ${activeCard.card_name} ${activeCard.masked_no}`} aria-label={`管理${activeCard.card_name} ${activeCard.masked_no}`} className={styles.cardManage} disabled={disabled} onClick={() => onSelect(activeCard.id)}>管理<ChevronRight size={15} /></button>
    </div>
    </>}
    <button data-agent-id="open-card-application" data-agent-permission="navigate" className={styles.outlineAction} disabled={disabled || !data.accounts[0]} onClick={onCreate}><Plus size={18} />申请虚拟卡<ChevronRight size={17} /></button>
  </div>;
}
