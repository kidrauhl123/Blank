import type { TimelineEvent, TimelineState } from "./app-agent-protocol";

export type AppAgentAuditEvent = {
  id: string;
  event_type: string;
  evidence: unknown;
  created_at: Date | string;
};

function field(evidence: unknown, key: string): string {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return "";
  const value = (evidence as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

// Never render arbitrary audit evidence, tool arguments, model text, or page
// content. A browser-reported page action is not a verified bank operation.
export function mapAppAgentTimeline(rows: AppAgentAuditEvent[]): TimelineEvent[] {
  return rows.map((row, index) => {
    const status = field(row.evidence, "status");
    const action = field(row.evidence, "toolAction");
    const report = field(row.evidence, "reportedStatus");
    const command = field(row.evidence, "command");
    let title = "Blank 状态已更新";
    let detail = "查看当前页面及银行回执确认业务状态。";
    let state: TimelineState = "done";

    if (row.event_type === "APP_AGENT_STARTED") {
      title = "收到任务"; detail = "Blank 开始核对当前页面。";
    } else if (row.event_type === "APP_AGENT_STEP") {
      if (status === "COMPLETED") { title = "Blank 本轮结束"; detail = "这不代表银行业务已执行；请以页面回执为准。"; }
      else if (status === "QUESTION") { title = "等待你补充信息"; detail = "Blank 需要你的回答才能继续。"; state = "waiting"; }
      else if (status === "HANDOFF") { title = "等待本人操作"; detail = "确认或强验证必须由你完成。"; state = "waiting"; }
      else if (status === "CONSENT") { title = "等待页面代操作授权"; detail = "允许后 Blank 才能操作页面。"; state = "waiting"; }
      else if (status === "ACTION") {
        title = action === "fill" ? "准备填写页面字段" : action === "click" ? "准备操作页面控件" : action === "scroll" ? "准备滚动页面" : "准备检查页面";
        detail = "页面动作尚未等于银行业务成功。"; state = "running";
      }
    } else if (row.event_type === "APP_AGENT_OBSERVATION") {
      if (report === "BLOCKED") { title = "页面动作被阻止"; detail = "Blank 会重新核对页面或请求你接管。"; state = "blocked"; }
      else if (report === "USER_CHANGED") { title = "页面已由你修改"; detail = "Blank 会按最新页面重新判断。"; state = "waiting"; }
      else if (report === "USER_ANSWERED") { title = "收到你的回答"; detail = "Blank 正在重新判断下一步。"; }
      else { title = "页面动作已回报"; detail = "仅表示浏览器报告了动作结果，未核实银行交易。"; }
    } else if (row.event_type === "APP_AGENT_CONTROL") {
      if (command === "allow") { title = "你允许页面代操作"; detail = "最终确认和强验证仍由你完成。"; }
      else if (command === "pause") { title = "你已暂停 Blank"; detail = "页面控制权已交回你。"; state = "paused"; }
      else if (command === "cancel") { title = "你已结束 Blank 任务"; detail = "请核对银行页面上的真实状态。"; state = "cancelled"; }
    } else if (row.event_type === "APP_AGENT_FAILED") {
      title = "Blank 运行中断"; detail = "请核对页面及银行回执，勿据此推断业务结果。"; state = "failed";
    }

    return { id: row.id, sequence: index + 1, at: new Date(row.created_at).toISOString(), title, detail, state };
  });
}
