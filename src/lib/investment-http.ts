import { z } from "zod";
import { apiError } from "./http";

const errors: Record<string, [number, string]> = {
  INVESTMENT_PRODUCT_UNAVAILABLE: [409, "这只产品当前不可申购。"],
  INVESTMENT_POSITION_UNAVAILABLE: [409, "持仓不存在、已赎回或不属于当前用户。"],
  INVESTMENT_LOCKED: [409, "尚未达到可赎回日期。"],
  INVESTMENT_MINIMUM_REQUIRED: [422, "申购金额低于起购金额。"],
  INVESTMENT_ASSESSMENT_REQUIRED: [409, "请先完成风险测评。"],
  INVESTMENT_RISK_MISMATCH: [409, "产品风险超过本次风险测评结果，请选择风险匹配的产品。"],
  INVESTMENT_DATE_CHANGED: [409, "估值日期已变化，请刷新后重新核对。"],
  INVESTMENT_DATE_INVALID: [422, "估值日期超出支持范围。"],
  INVESTMENT_VALUE_INVALID: [422, "金额或份额无法计算，请重新核对。"],
};
export function investmentApiError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "INVALID_INVESTMENT_INPUT", message: "请检查产品、金额与确认信息。" }, { status: 422 });
  const code = error instanceof Error ? error.message : "";
  const entry = errors[code];
  if (entry) return Response.json({ error: code, message: entry[1] }, { status: entry[0] });
  return apiError(error, "INVESTMENT_REQUEST_FAILED");
}
