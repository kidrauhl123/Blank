const failures: Record<string, [number, string]> = {
  APP_AGENT_NOT_FOUND: [404, "没有找到当前登录会话的助手任务"],
  APP_AGENT_EXPIRED: [410, "任务已过期，请重新发起"],
  APP_AGENT_BUSY: [409, "助手正在更新任务，请稍后继续"],
  APP_AGENT_STATE_CHANGED: [409, "任务状态已变化，请刷新后继续"],
  APP_AGENT_CONTROL_REQUIRED: [403, "尚未允许助手接管页面"],
  APP_AGENT_LIMIT: [422, "本次任务达到步骤上限，请接手操作"],
  APP_AGENT_RATE_LIMIT: [429, "发起任务过于频繁，请稍后再试"],
  AI_MODEL_NOT_AVAILABLE: [422, "当前模型不可用，请到「个人中心 → 设置」选择其他模型并保存后重试。"],
  AI_MODEL_CATALOG_UNAVAILABLE: [503, "模型列表暂时不可用，请稍后重试"],
  AI_NOT_CONFIGURED: [503, "真实 AI 模型尚未配置，无法启动代操作"],
  AI_MODEL_ACCESS_DENIED: [502, "模型服务拒绝了当前模型的访问，请到「个人中心 → 设置」更换模型后重试。"],
  AI_MODEL_QUOTA_EXHAUSTED: [503, "当前模型的服务额度不足，请更换模型或检查网关额度。"],
  AI_MODEL_RATE_LIMIT: [503, "模型服务请求过于频繁，请稍后重试或更换模型。"],
  AI_MODEL_TIMEOUT: [504, "模型响应超时，请稍后重试或在设置中更换模型。"],
  AI_MODEL_REQUEST_REJECTED: [502, "当前模型未接受助手工具请求，请到设置更换模型。"],
  AI_MODEL_SERVICE_UNAVAILABLE: [503, "模型服务暂时不可用，请稍后重试或更换模型。"],
  APP_AGENT_FAILED: [502, "助手暂时不可用。请核对页面状态，可手动继续办理。"],
};

export function appAgentFailure(error: unknown) {
  let code = error instanceof Error && Object.hasOwn(failures, error.message) ? error.message : "APP_AGENT_FAILED";
  let upstreamStatus: number | undefined;
  let timeout = false;
  let current = error;
  const seen = new Set<object>();
  // SDKs may wrap provider failures. Never return or log their body, message or headers.
  for (let depth = 0; depth < 32 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    if ("status" in current && typeof current.status === "number" && Number.isInteger(current.status) && current.status >= 400 && current.status <= 599) upstreamStatus ??= current.status;
    if ("name" in current && ["APIConnectionTimeoutError", "TimeoutError", "AbortError"].includes(String(current.name))) timeout = true;
    current = "cause" in current ? current.cause : undefined;
  }
  if (code === "APP_AGENT_FAILED") {
    if (upstreamStatus === 401 || upstreamStatus === 403) code = "AI_MODEL_ACCESS_DENIED";
    else if (upstreamStatus === 402) code = "AI_MODEL_QUOTA_EXHAUSTED";
    else if (upstreamStatus === 429) code = "AI_MODEL_RATE_LIMIT";
    else if (timeout || upstreamStatus === 408 || upstreamStatus === 504) code = "AI_MODEL_TIMEOUT";
    else if (upstreamStatus === 400 || upstreamStatus === 404 || upstreamStatus === 422) code = "AI_MODEL_REQUEST_REJECTED";
    else if (upstreamStatus && upstreamStatus >= 500) code = "AI_MODEL_SERVICE_UNAVAILABLE";
  }
  const [status, message] = failures[code];
  return { code, status, message, upstreamStatus };
}
