export class BankRequestError extends Error {
  constructor(message: string, public readonly outcomeUnknown: boolean, public readonly status?: number, public readonly code?: string) { super(message); }
}

export async function bankRequest<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { cache: "no-store", ...init }); }
  catch { throw new BankRequestError("连接中断，暂时无法确认操作结果。请先查看最新明细或卡片状态，避免重复提交。", true); }
  let result: T & { message?: string; error?: string };
  try { result = await response.json(); }
  catch { throw new BankRequestError("暂时无法读取操作回执，请先核对最新状态。", true, response.status); }
  if (!result || typeof result !== "object") throw new BankRequestError("操作回执不完整，请先核对最新状态。", true, response.status);
  if (!response.ok) throw new BankRequestError(result.message || "操作未完成，请核对信息后重试。", response.status >= 500, response.status, result.error);
  return result;
}

export const jsonPost = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
