// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BankingApp } from "./BankingApp";
import type { InvestmentReceipt } from "@/lib/investment-types";

vi.mock("./FloatingAppAgent", () => ({ FloatingAppAgent: () => null }));
const receipt: InvestmentReceipt = { operationId: "DEMO-INV-potato-past-SELL", status: "SUCCEEDED", side: "REDEEM", productName: "日享灵活",
  amountMinor: 201000, feeMinor: 101, settlementMinor: 200899, quantityMicro: 2000000000, navMicros: 1005000,
  businessDate: "2026-09-02", positionId: "position-1", ledgerReference: "LED-DEMO-INV-potato-past-SELL" };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    customer: { display_name: "小土豆", phone: "99000000001", mfa_configured: false }, totalMinor: 100000,
    accounts: [{ id: "account-1", name: "活期账户", masked_no: "•• 1234", available_balance_minor: "100000" }], cards: [],
    transactions: [
      { id: "redemption", merchant_name: "日享灵活 · 模拟历史赎回", category: "模拟理财", amount_minor: "200899", occurred_at: "2026-09-02T03:00:00Z", investment_receipt: receipt },
      { id: "purchase", merchant_name: "日享灵活 · 模拟历史申购", category: "模拟理财", amount_minor: "-200000", occurred_at: "2026-08-28T02:00:00Z", investment_receipt: { ...receipt, operationId: "DEMO-INV-potato-past-BUY", ledgerReference: "LED-DEMO-INV-potato-past-BUY", side: "SUBSCRIBE", amountMinor: 200000, feeMinor: 0, settlementMinor: 200000, navMicros: 1000000, businessDate: "2026-08-28" } },
      { id: "coffee", merchant_name: "咖啡", category: "餐饮", amount_minor: "-3200", occurred_at: "2026-09-01T00:00:00Z" },
    ], ai: { configured: false, model: null }, statement: { month: "2026-10", expenseMinor: 0, categories: [] },
  })));
  Element.prototype.scrollTo = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const openActivity = async () => {
  await act(async () => root.render(<BankingApp />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-id="nav-activity"]')!.click());
};
const rowText = (label: string) => [...container.querySelectorAll("dl > div")].find(row => row.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent;

describe("investment receipts linked from account activity", () => {
  it("shows net redemption cash and opens the same receipt with fees and identifiers", async () => {
    await openActivity();
    const transaction = container.querySelector<HTMLButtonElement>('[data-agent-id="transaction-redemption"]')!;
    expect(transaction.textContent).toContain("+¥2,008.99");
    expect(transaction.dataset.agentPermission).toBe("navigate");
    await act(async () => transaction.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("预置模拟历史回执");
    expect(rowText("赎回市值")).toBe("¥2,010.00");
    expect(rowText("赎回费用")).toBe("¥1.01");
    expect(rowText("账户到账")).toBe("¥2,008.99");
    expect(rowText("计价日期")).toBe(receipt.businessDate);
    expect(rowText("操作编号")).toBe(receipt.operationId);
    expect(rowText("流水编号")).toBe(receipt.ledgerReference);
    expect(rowText("记账时间")).toContain("11:00:00");
  });
  it("shows the whole purchase debit and leaves ordinary transactions without investment receipts", async () => {
    await openActivity();
    expect(container.querySelector('[data-agent-id="transaction-coffee"]')).toBeNull();
    const transaction = container.querySelector<HTMLButtonElement>('[data-agent-id="transaction-purchase"]')!;
    expect(transaction.textContent).toContain("−¥2,000.00");
    await act(async () => transaction.click());
    expect(rowText("账户扣款")).toBe("¥2,000.00");
    expect(rowText("用于购买份额")).toBe("¥2,000.00");
    expect(rowText("计价日期")).toBe("2026-08-28");
  });
});
