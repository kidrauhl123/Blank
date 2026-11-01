// 演示参考中间价（人民币元 / 1 单位外币）。仅供参考，不是成交价；换汇以网点当时的挂牌价为准。
export const FX_CURRENCIES = ["USD", "EUR", "HKD", "GBP", "JPY"] as const;
export type FxCurrency = (typeof FX_CURRENCIES)[number];

export const FX_RATE_DATE = "2026-10-31";
const RATES: Record<FxCurrency, { name: string; midCnyPerUnit: number }> = {
  USD: { name: "美元", midCnyPerUnit: 7.1 },
  EUR: { name: "欧元", midCnyPerUnit: 8.2 },
  HKD: { name: "港币", midCnyPerUnit: 0.91 },
  GBP: { name: "英镑", midCnyPerUnit: 9.2 },
  JPY: { name: "日元", midCnyPerUnit: 0.0465 },
};

export function getFxRates(currency?: FxCurrency) {
  const codes = currency ? [currency] : [...FX_CURRENCIES];
  return {
    rateDate: FX_RATE_DATE,
    note: "参考中间价，仅供参考，不是成交价；换汇以网点当时的挂牌价为准，App 不会据此扣款。",
    rates: codes.map(code => ({ currency: code, name: RATES[code].name, midCnyPerUnit: RATES[code].midCnyPerUnit })),
  };
}

// 按参考中间价折算成人民币元（两位小数），只用于预约时的参考金额。
export function estimateCnyYuan(currency: FxCurrency, amount: number) {
  return Math.round(amount * RATES[currency].midCnyPerUnit * 100) / 100;
}
