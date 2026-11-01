import { describe, expect, it } from "vitest";
import { checkReservation, describeReservation, reservationInput, type ReservationInput } from "./bank-reservations";

// 2026-11-02 是周一（北京时间）；2026-11-07 是周六。
const MONDAY_09 = new Date("2026-11-02T01:00:00Z");
const parse = (input: unknown): ReservationInput => reservationInput.parse(input);
const queue = (overrides: Record<string, unknown> = {}) => parse({ kind: "QUEUE", branchId: "BJ-CY-001", service: "personal", date: "2026-11-02", time: "10:00", ...overrides });
const fx = (overrides: Record<string, unknown> = {}) => parse({ kind: "FX", branchId: "BJ-CY-001", direction: "BUY", currency: "USD", amount: 1000, date: "2026-11-02", time: "10:00", ...overrides });

describe("网点预约的校验", () => {
  it("营业时间内、办理这项业务的网点可以预约", () => {
    const result = checkReservation(queue(), MONDAY_09);
    expect(result).toMatchObject({ ok: true, summary: "朝阳支行 · 取号办理个人业务 · 2026-11-02 10:00" });
  });

  it("周日不营业；周六只到中午 12 点，时段必须整段在营业时间内", () => {
    expect(checkReservation(queue({ date: "2026-11-08" }), MONDAY_09)).toMatchObject({ ok: false, error: expect.stringContaining("不营业") });
    expect(checkReservation(queue({ date: "2026-11-07", time: "11:30" }), MONDAY_09)).toMatchObject({ ok: true });
    expect(checkReservation(queue({ date: "2026-11-07", time: "12:00" }), MONDAY_09)).toMatchObject({ ok: false, error: expect.stringContaining("不营业") });
  });

  it("网点不办理的业务不能预约；ATM 不能预约", () => {
    expect(checkReservation(fx({ branchId: "BJ-HD-002" }), MONDAY_09)).toMatchObject({ ok: false, error: expect.stringContaining("不办理这项业务") });
    expect(checkReservation(queue({ branchId: "ATM-BJ-CY-01" }), MONDAY_09)).toMatchObject({ ok: false, error: expect.stringContaining("没有这家网点") });
  });

  it("日期只能是今天起 7 天以内；太近的时段不行", () => {
    expect(checkReservation(queue({ date: "2026-11-10" }), MONDAY_09)).toMatchObject({ ok: false, error: expect.stringContaining("7 天以内") });
    expect(checkReservation(queue({ time: "09:00" }), new Date("2026-11-02T00:50:00Z"))).toMatchObject({ ok: false, error: expect.stringContaining("太近") });
    expect(checkReservation(queue({ time: "09:30" }), new Date("2026-11-02T00:50:00Z"))).toMatchObject({ ok: true });
  });

  it("输入格式不对的时段在解析时就被拒绝", () => {
    expect(() => queue({ time: "10:15" })).toThrow();
    expect(() => fx({ amount: 0 })).toThrow();
    expect(() => fx({ amount: 1.5 })).toThrow();
    expect(() => parse({ kind: "QUEUE", branchId: "BJ-CY-001", service: "personal", date: "2026-11-02", time: "10:00", extra: 1 })).toThrow();
  });

  it("换汇的摘要写明参考折算，并说明不是成交价", () => {
    expect(describeReservation(fx(), "朝阳支行")).toBe("朝阳支行 · 买入 1000 USD · 参考折算约 7100.00 元（参考中间价，不是成交价）· 2026-11-02 10:00");
  });
});
