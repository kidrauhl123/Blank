"use client";

import { BankDialog } from "./BankDialog";
import { NAV_SCALE, SHARE_SCALE } from "@/lib/investment-model";
import type { InvestmentReceipt } from "@/lib/investment-types";
import styles from "./InvestmentView.module.css";

const money = (minor: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(minor / 100);

export function InvestmentReceiptDialog({ receipt, close, onViewHoldings, postedAt }: {
  receipt: InvestmentReceipt; close: () => void; onViewHoldings?: () => void; postedAt?: string;
}) {
  const subscribe = receipt.side === "SUBSCRIBE";
  return <BankDialog title={subscribe ? "模拟申购已完成" : "模拟赎回已到账"} eyebrow={receipt.operationId.startsWith("DEMO-INV-") ? "预置模拟历史回执" : "银行沙箱回执"} close={close}>
    <div className={styles.dialog}>
      <p>{receipt.productName}</p>
      <p className={styles.receiptValue}>{money(subscribe ? receipt.amountMinor : receipt.settlementMinor)}</p>
      <dl className={styles.facts}>
        <div><dt>{subscribe ? "账户扣款" : "赎回市值"}</dt><dd>{money(receipt.amountMinor)}</dd></div>
        <div><dt>{subscribe ? "申购费用" : "赎回费用"}</dt><dd>{money(receipt.feeMinor)}</dd></div>
        <div><dt>{subscribe ? "用于购买份额" : "账户到账"}</dt><dd>{money(receipt.settlementMinor)}</dd></div>
        <div><dt>模拟净值 / 份额</dt><dd>{(receipt.navMicros / NAV_SCALE).toFixed(6)} / {(receipt.quantityMicro / SHARE_SCALE).toFixed(6)}</dd></div>
        <div><dt>计价日期</dt><dd>{receipt.businessDate}</dd></div>
        {postedAt && <div><dt>记账时间</dt><dd>{new Date(postedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 北京时间</dd></div>}
        <div><dt>操作编号</dt><dd>{receipt.operationId}</dd></div>
        <div><dt>流水编号</dt><dd>{receipt.ledgerReference}</dd></div>
      </dl>
      {onViewHoldings && <button className={styles.primary} data-agent-id="wealth-view-holdings" data-agent-permission="navigate" onClick={onViewHoldings}>查看持仓</button>}
    </div>
  </BankDialog>;
}
