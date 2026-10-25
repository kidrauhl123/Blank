"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, RefreshCw } from "lucide-react";
import { BankDialog } from "./BankDialog";
import { InvestmentReceiptDialog } from "./InvestmentReceiptDialog";
import { bankRequest, jsonPost } from "@/lib/client-request";
import { investmentKindLabels, NAV_SCALE, SHARE_SCALE, type InvestmentKind } from "@/lib/investment-model";
import type { InvestmentOrder, InvestmentOverview, InvestmentProduct, InvestmentReceipt } from "@/lib/investment-types";
import styles from "./InvestmentView.module.css";

type Account = { id: string; name: string; masked_no: string; available_balance_minor: string };
const money = (minor: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(minor / 100);
const percent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const rate = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const quantity = (micro: number) => (micro / SHARE_SCALE).toFixed(6);
const term = (product: InvestmentProduct) => product.holdingDays ? `${product.holdingDays} 天${product.kind === "CLOSED" ? "封闭" : "起持有"}` : "随时申赎";
type Trade = { side: "SUBSCRIBE"; product: InvestmentProduct; key: string } | { side: "REDEEM"; positionId: string; key: string };

export function InvestmentView({ accounts, mfaConfigured, onChanged }: { accounts: Account[]; mfaConfigured: boolean; onChanged: (message?: string) => Promise<unknown> }) {
  const [data, setData] = useState<InvestmentOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [screen, setScreen] = useState<"products" | "positions">("products");
  const [kind, setKind] = useState<InvestmentKind | "ALL">("ALL");
  const [budget, setBudget] = useState("");
  const [risk, setRisk] = useState("R5");
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [order, setOrder] = useState<InvestmentOrder | null>(null);
  const [receipt, setReceipt] = useState<InvestmentReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [code, setCode] = useState("");
  const [advance, setAdvance] = useState<number | null>(null);
  const pending = useRef(false);
  const storageKey = `bankpilot-investment-order-${accounts[0]?.id ?? "none"}`;

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await bankRequest<InvestmentOverview>("/api/v1/investments")); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "理财数据暂时无法读取。"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void load();
      const saved = sessionStorage.getItem(storageKey);
      if (saved) void bankRequest<InvestmentOrder>(`/api/v1/investments/orders/${encodeURIComponent(saved)}`).then(result => {
        if (!active) return;
        if (result.receipt) { setReceipt(result.receipt); sessionStorage.removeItem(storageKey); }
        else if (result.status === "AWAITING_AUTH") setOrder(result);
        else sessionStorage.removeItem(storageKey);
      }).catch(() => { /* Keep the operation reference for an explicit retry. */ });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [load, storageKey]);

  const work = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFormError("");
    try { await action(); }
    catch (reason) { setFormError(reason instanceof Error ? reason.message : "暂时无法确认结果，请重新读取回执。"); }
    finally { pending.current = false; setBusy(false); }
  };
  const acceptOrder = (result: InvestmentOrder) => {
    if (result.receipt) { setReceipt(result.receipt); setOrder(null); sessionStorage.removeItem(storageKey); }
    else { setOrder(result); sessionStorage.setItem(storageKey, result.operationId); }
    setTrade(null); setCode("");
  };
  const prepare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trade) return;
    const values = new FormData(event.currentTarget);
    void work(async () => {
      const body = trade.side === "SUBSCRIBE" ? { side: trade.side, productId: trade.product.id, accountId: values.get("account"),
        amountMinor: Math.round(Number(values.get("amount")) * 100), idempotencyKey: trade.key }
        : { side: trade.side, positionId: trade.positionId, idempotencyKey: trade.key };
      acceptOrder(await bankRequest<InvestmentOrder>("/api/v1/investments/orders", jsonPost(body)));
    });
  };
  const readReceipt = () => { if (order) void work(async () => {
    const result = await bankRequest<InvestmentOrder>(`/api/v1/investments/orders/${encodeURIComponent(order.operationId)}`);
    acceptOrder(result);
    if (result.receipt) { await load(); await onChanged(result.receipt.side === "SUBSCRIBE" ? "模拟申购已完成。" : "模拟赎回已到账。"); }
  }); };
  const confirm = () => { if (order) void work(async () => {
    const result = await bankRequest<{ receipt: InvestmentReceipt }>(`/api/v1/investments/orders/${encodeURIComponent(order.operationId)}`, jsonPost({ confirmed: true, ...(code ? { totpCode: code } : {}) }));
    setReceipt(result.receipt); setOrder(null); setCode(""); sessionStorage.removeItem(storageKey);
    await load(); await onChanged(result.receipt.side === "SUBSCRIBE" ? "模拟申购已完成。" : "模拟赎回已到账。");
  }); };
  const cancel = () => { if (order) void work(async () => {
    await bankRequest(`/api/v1/investments/orders/${encodeURIComponent(order.operationId)}`, { method: "DELETE" });
    sessionStorage.removeItem(storageKey); setOrder(null); setCode("");
  }); };
  const saveAssessment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void work(async () => {
      await bankRequest("/api/v1/investments/assessment", jsonPost({ answers: [1, 2, 3].map(index => Number(values.get(`answer${index}`))), confirmed: true }));
      setAssessmentOpen(false); setNotice("模拟测评已保存。"); await load();
    });
  };
  const openTrade = (next: Trade) => { setFormError(""); setTrade(next); };
  const product = data?.products.find(item => item.id === selected);
  const products = data?.products.filter(item => (kind === "ALL" || item.kind === kind) && item.riskLevel <= risk && (!budget || item.minimumMinor <= Math.round(Number(budget) * 100))) ?? [];
  const compared = data?.products.filter(item => compare.includes(item.id)) ?? [];
  const quote = order?.quote;

  return <div className={styles.view}>
    <div className={styles.heading}><h1>理财</h1><span className={styles.tag}>比赛模拟</span></div>
    <p className={styles.hint}>模拟产品与资金，净值会涨跌，不承诺收益。</p>
    {error && <div role="alert" className={styles.error}>{error}<button className={styles.textButton} onClick={() => void load()} disabled={loading}><RefreshCw size={14} />重新读取</button></div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {loading && <p role="status" className={styles.hint}>正在读取理财数据…</p>}
    {data && <>
      <div className={styles.tabs} aria-label="理财导航">
        <button data-agent-id="wealth-products" data-agent-permission="navigate" aria-pressed={screen === "products"} onClick={() => { setScreen("products"); setSelected(null); }}>产品</button>
        <button data-agent-id="wealth-positions" data-agent-permission="navigate" aria-pressed={screen === "positions"} onClick={() => { setScreen("positions"); setSelected(null); }}>我的持仓</button>
        <button data-agent-id="wealth-assessment" data-agent-permission="navigate" onClick={() => { setFormError(""); setAssessmentOpen(true); }}>{data.assessment ? `模拟测评 ${data.assessment.riskLevel}` : "模拟风险测评"}</button>
      </div>
      {screen === "products" && !product && <>
        <div className={styles.filters} aria-label="产品类型">{(["ALL", "FLEXIBLE", "HOLDING", "CLOSED"] as const).map(value => <button key={value} data-agent-id={`wealth-filter-${value}`} data-agent-permission="navigate" aria-pressed={kind === value} onClick={() => setKind(value)}>{value === "ALL" ? "全部" : investmentKindLabels[value]}</button>)}</div>
        <div className={styles.criteria}>
          <label>可投入金额（元）<input data-agent-id="wealth-budget" data-agent-permission="fill" type="number" inputMode="decimal" min="0.01" step="0.01" value={budget} placeholder="不限" onChange={event => setBudget(event.target.value)} /></label>
          <label>最高产品风险<select data-agent-id="wealth-max-risk" data-agent-permission="fill" value={risk} onChange={event => setRisk(event.target.value)}><option value="R5">不限</option>{["R1", "R2", "R3"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        <div className={styles.row}><small>{products.length} 只符合条件</small><button className={styles.textButton} data-agent-id="wealth-compare" data-agent-permission="navigate" disabled={compare.length < 2} onClick={() => setCompareOpen(true)}>对比（{compare.length}/3）</button></div>
        <div>{products.map(item => <article className={styles.card} key={item.id}>
          <button className={styles.open} data-agent-id={`wealth-product-${item.code}`} data-agent-permission="navigate" data-agent-label={`查看 ${item.name} ${item.riskLevel} ${term(item)}`} onClick={() => setSelected(item.id)}>
            <span className={styles.row}><h2>{item.name}</h2><ChevronRight size={18} /></span>
            <span className={styles.tag}>{item.riskLevel} · {term(item)}</span>
            <span className={styles.metrics}><span><b className={item.change30DaysPercent >= 0 ? styles.positive : styles.negative}>{percent(item.change30DaysPercent)}</b><small>近 30 天模拟净值变化</small></span><span><b>{money(item.minimumMinor)}</b><small>起购金额</small></span></span>
          </button>
          <div className={styles.cardFooter}><small>{item.status === "OPEN" ? "可申购" : "暂停申购"}</small><button className={styles.textButton} data-agent-id={`wealth-compare-${item.code}`} data-agent-permission="navigate" aria-pressed={compare.includes(item.id)} disabled={!compare.includes(item.id) && compare.length >= 3} onClick={() => setCompare(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}>{compare.includes(item.id) ? "移出对比" : "加入对比"}</button></div>
        </article>)}{!products.length && <p className={styles.empty}>没有符合条件的产品，可以调整金额或期限要求。</p>}</div>
      </>}
      {screen === "products" && product && <>
        <button className={styles.back} data-agent-id="wealth-back" data-agent-permission="navigate" onClick={() => setSelected(null)}><ArrowLeft size={16} />全部产品</button>
        <section className={styles.card}>
          <div className={styles.detailHead}><small>{product.code} · {product.riskLevel}</small><h2>{product.name}</h2><span className={styles.hint}>{product.issuer}</span></div>
          <dl className={styles.facts}>
            <div><dt>产品类型</dt><dd>{investmentKindLabels[product.kind]}</dd></div><div><dt>起购金额</dt><dd>{money(product.minimumMinor)}</dd></div>
            <div><dt>持有规则</dt><dd>{term(product)}{product.holdingDays > 0 && "，到期后可赎回"}</dd></div>
            <div><dt>申购 / 赎回费率</dt><dd>{rate(product.purchaseFeeBps)} / {rate(product.redemptionFeeBps)}</dd></div>
            <div><dt>确认与到账</dt><dd>本人确认后即时模拟完成</dd></div>
          </dl>
          <small>模拟单位净值 · {data.businessDate}</small><p className={styles.navValue}>{(product.navMicros / NAV_SCALE).toFixed(6)}</p>
          <PriceChart product={product} />
          <p className={styles.hint}>收益随模拟净值变化；份额保留六位，费用按分向上取整，估值按分向下取整。</p>
          <button className={styles.primary} data-agent-id="wealth-open-subscribe" data-agent-permission="navigate" disabled={loading || product.status !== "OPEN" || !accounts.length} onClick={() => openTrade({ side: "SUBSCRIBE", product, key: crypto.randomUUID() })}>申购</button>
        </section>
      </>}
      {screen === "positions" && <>
        <section className={`${styles.card} ${styles.summary}`} aria-label="理财持仓总览"><span><small>模拟持仓市值</small><b>{money(data.valueMinor)}</b></span><span><small>持有盈亏 · 未扣赎回费</small><b className={data.profitMinor >= 0 ? styles.positive : styles.negative}>{money(data.profitMinor)}</b></span></section>
        <div>{data.positions.map(position => <article key={position.id} className={styles.card}>
          <h2>{position.productName}</h2><dl className={styles.facts}>
            <div><dt>当前市值</dt><dd>{money(position.valueMinor)}</dd></div><div><dt>持有盈亏</dt><dd className={position.profitMinor >= 0 ? styles.positive : styles.negative}>{money(position.profitMinor)}</dd></div>
            <div><dt>持有份额</dt><dd>{quantity(position.quantityMicro)}</dd></div><div><dt>申购 / 可赎回日期</dt><dd>{position.purchasedOn}<br />{position.unlocksOn}</dd></div>
          </dl><button className={styles.primary} data-agent-id={`wealth-redeem-${position.id}`} data-agent-permission="navigate" disabled={loading || !position.redeemable} onClick={() => openTrade({ side: "REDEEM", positionId: position.id, key: crypto.randomUUID() })}>{position.redeemable ? "全部赎回" : "尚未到可赎回日期"}</button>
        </article>)}{!data.positions.length && <p className={styles.empty}>还没有持仓，申购后会显示在这里。</p>}</div>
        <section aria-label="理财交易记录">
          <div className={styles.row}><h2 className={styles.historyHeading}>交易记录</h2><small>最近 20 笔</small></div>
          {(data.history ?? []).map(entry => <button key={entry.receipt.operationId} className={styles.historyRow} data-agent-id={`wealth-history-${entry.receipt.operationId}`} data-agent-permission="navigate" onClick={() => setReceipt(entry.receipt)}>
            <span><b>{entry.receipt.productName}</b><small>{entry.receipt.side === "SUBSCRIBE" ? "申购" : "赎回"} · {entry.receipt.businessDate}{entry.source === "DEMO_SEED" && " · 预置模拟历史"}</small></span>
            <span><b>{entry.receipt.side === "SUBSCRIBE" ? "−" : "+"}{money(entry.receipt.side === "SUBSCRIBE" ? entry.receipt.amountMinor : entry.receipt.settlementMinor)}</b><small>已完成</small></span>
          </button>)}{!data.history?.length && <p className={styles.empty}>还没有理财交易记录。</p>}
        </section>
      </>}
      <section className={styles.clock} aria-label="演示日期"><div className={styles.row}><small>演示日期 · {data.businessDate}</small><span className={styles.tag}>仅影响本模拟账户的理财</span></div><div className={styles.filters}>{[1, 30, 90].map(days => <button key={days} data-agent-id={`wealth-advance-${days}`} data-agent-permission="human" disabled={loading || busy} onClick={() => { setFormError(""); setAdvance(days); }}>推进 {days} 天</button>)}</div></section>
    </>}
    {compareOpen && <BankDialog title="产品对比" eyebrow="模拟产品 · 按条件比较" close={() => setCompareOpen(false)}><div className={styles.dialog}>
      <table className={styles.table}><thead><tr><th>项目</th>{compared.map(item => <th key={item.id}>{item.name}</th>)}</tr></thead><tbody>{[
        ["风险", ...compared.map(item => item.riskLevel)], ["起购金额", ...compared.map(item => money(item.minimumMinor))],
        ["持有规则", ...compared.map(term)], ["申购费", ...compared.map(item => rate(item.purchaseFeeBps))], ["赎回费", ...compared.map(item => rate(item.redemptionFeeBps))],
        ["近30天模拟变化", ...compared.map(item => percent(item.change30DaysPercent))],
      ].map(row => <tr key={row[0]}>{row.map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table><small>历史模拟表现不代表未来收益。候选匹配不等于已通过风险测评。</small>
    </div></BankDialog>}
    {assessmentOpen && <BankDialog title="模拟风险测评" eyebrow="仅用于比赛演示 · 请本人填写" close={() => setAssessmentOpen(false)} busy={busy}>
      <form className={styles.form} onSubmit={saveAssessment}>
        {[
          ["本金出现损失时，你能接受到什么程度？", "不能接受", "可以接受小幅损失", "可以接受明显波动和损失"],
          ["产品净值下跌时，你更接近哪种选择？", "希望立即退出", "了解原因后再决定", "能够按计划继续持有"],
          ["你对投资产品的了解程度？", "刚开始了解", "了解净值、费用和赎回规则", "有经验并理解亏损风险"],
        ].map((question, index) => <label key={question[0]}>{question[0]}<select name={`answer${index + 1}`} data-agent-id={`wealth-risk-answer-${index}`} data-agent-permission="human" required defaultValue="" disabled={busy}><option value="" disabled>请本人选择</option>{question.slice(1).map((option, value) => <option key={option} value={value + 1}>{option}</option>)}</select></label>)}
        <small>按三项回答中较保守的一项给出模拟 R1–R3，有效期一年。</small>{formError && <p role="alert" className={styles.error}>{formError}</p>}
        <button className={styles.primary} data-agent-id="wealth-confirm-assessment" data-agent-permission="human" disabled={busy}>确认模拟测评</button>
      </form>
    </BankDialog>}
    {trade && !order && <BankDialog title={trade.side === "SUBSCRIBE" ? `申购 ${trade.product.name}` : "赎回持仓"} eyebrow="模拟理财 · 先核对，再确认" close={() => setTrade(null)} busy={busy}>
      <form className={styles.form} onSubmit={prepare}>
        {trade.side === "SUBSCRIBE" ? <>
          <label>付款账户<select name="account" data-agent-id="wealth-account" data-agent-permission="fill" disabled={busy} defaultValue={accounts[0]?.id}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} {account.masked_no} · {money(Number(account.available_balance_minor))}</option>)}</select></label>
          <label>申购金额（元）<input name="amount" data-agent-id="wealth-amount" data-agent-permission="fill" type="number" inputMode="decimal" required min={trade.product.minimumMinor / 100} max="1000000" step="0.01" disabled={busy} /></label>
          <small>{trade.product.riskLevel} · {term(trade.product)} · 申购费 {rate(trade.product.purchaseFeeBps)}。需要有效模拟测评和验证器动态码。</small>
        </> : <p>赎回这笔持仓的全部份额，金额以核对页的模拟净值与费用计算。</p>}
        {formError && <p role="alert" className={styles.error}>{formError}</p>}
        <button className={styles.primary} data-agent-id="wealth-prepare-order" data-agent-permission="prepare" disabled={busy}>继续核对</button>
      </form>
    </BankDialog>}
    {order && quote && <BankDialog title={quote.side === "SUBSCRIBE" ? "核对模拟申购" : "核对模拟赎回"} eyebrow={quote.requiredAuth === "MFA" ? "红色操作 · 本人强验证" : "黄色操作 · 本人确认"} close={() => { if (!busy) cancel(); }} busy={busy}>
      <div className={styles.dialog}>
        <dl className={styles.facts}>
          <div><dt>产品</dt><dd>{quote.productName} · {quote.riskLevel}</dd></div><div><dt>账户</dt><dd>{quote.accountMaskedNo}</dd></div>
          <div><dt>{quote.side === "SUBSCRIBE" ? "扣款金额" : "持仓市值"}</dt><dd>{money(quote.amountMinor)}</dd></div><div><dt>费用</dt><dd>{money(quote.feeMinor)}</dd></div>
          <div><dt>{quote.side === "SUBSCRIBE" ? "用于购买份额" : "实际到账"}</dt><dd>{money(quote.settlementMinor)}</dd></div>
          <div><dt>模拟净值 / 份额</dt><dd>{(quote.navMicros / NAV_SCALE).toFixed(6)} / {quantity(quote.quantityMicro)}</dd></div>
          <div><dt>计价日期</dt><dd>{quote.businessDate}</dd></div><div><dt>可赎回日期</dt><dd>{quote.unlocksOn}</dd></div>
          <div><dt>报价有效至</dt><dd>{new Date(order.expiresAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })} 北京时间</dd></div>
        </dl>
        {quote.requiredAuth === "MFA" && (mfaConfigured ? <label className={styles.form}>验证器动态码<input aria-label="理财验证器动态码" data-agent-private autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} disabled={busy} /></label> : <p className={styles.hint}>请先到<a className={styles.textButton} href="/security">安全中心</a>启用验证器。回来后可继续核对这笔草稿。</p>)}
        {formError && <p role="alert" className={styles.error}>{formError}</p>}
        <button className={styles.primary} data-agent-id="wealth-confirm-order" data-agent-permission="human" disabled={busy || order.status !== "AWAITING_AUTH" || (quote.requiredAuth === "MFA" && (!mfaConfigured || code.length !== 6))} onClick={confirm}>{quote.side === "SUBSCRIBE" ? "确认模拟申购" : "确认模拟赎回"}</button>
        <div className={styles.row}><button className={styles.textButton} data-agent-id="wealth-read-receipt" data-agent-permission="navigate" disabled={busy} onClick={readReceipt}>重新读取回执</button><button className={styles.textButton} data-agent-id="wealth-cancel-order" data-agent-permission="human" disabled={busy} onClick={cancel}>取消办理</button></div>
      </div>
    </BankDialog>}
    {receipt && <InvestmentReceiptDialog receipt={receipt} close={() => setReceipt(null)} onViewHoldings={() => { setReceipt(null); setScreen("positions"); setSelected(null); }} />}
    {advance !== null && data && <BankDialog title={`推进 ${advance} 天`} eyebrow="模拟理财日期" close={() => setAdvance(null)} busy={busy}><div className={styles.dialog}><p>更新本模拟账户的产品净值、持仓估值和可赎回状态。现有未确认报价将作废，账户转账和其他定时任务不受影响。</p>{formError && <p role="alert" className={styles.error}>{formError}</p>}<button className={styles.primary} data-agent-id="wealth-confirm-advance" data-agent-permission="human" disabled={busy} onClick={() => void work(async () => {
      await bankRequest("/api/v1/investments/clock", jsonPost({ days: advance, expectedDate: data.businessDate, confirmed: true })); setAdvance(null); await load(); await onChanged();
    })}>确认推进</button></div></BankDialog>}
  </div>;
}

function PriceChart({ product }: { product: InvestmentProduct }) {
  const values = product.history.map(point => point.navMicros);
  const min = Math.min(...values), max = Math.max(...values);
  const path = values.map((value, index) => `${index * 300 / Math.max(values.length - 1, 1)},${80 - (value - min) / Math.max(max - min, 1) * 72}`).join(" ");
  return <><svg className={styles.chart} viewBox="0 0 300 88" preserveAspectRatio="none" role="img" aria-label={`${product.name}近30天模拟净值走势，区间变化${percent(product.change30DaysPercent)}`}><polyline points={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg><div className={styles.chartLabels}><span>{product.history[0]?.date}</span><span>{product.history.at(-1)?.date}</span></div></>;
}
