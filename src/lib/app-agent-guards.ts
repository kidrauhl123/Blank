import type { AppPage, PageAction } from "./app-agent-protocol";

const monetaryOption = /(?:[¥￥]\s*\d|\d[\d,.]*\s*(?:元|块|角|分))/u;
const bareAmount = /^\s*\d[\d,.]*\s*$/u;

export function guardQuestion(action: PageAction, userMessage: string): PageAction {
  if (action.type !== "question") return action;
  const asksAmount = /金额|多少钱|转多少|汇多少/u.test(action.question);
  const invented = action.options.some((option) =>
    (monetaryOption.test(option) || (asksAmount && bareAmount.test(option))) && !userMessage.includes(option.trim()));
  return invented ? { type: "question", question: "请自行输入具体金额，或暂不办理。", options: ["自行输入", "暂不办理"] } : action;
}

export function needsHumanHandoff(page: AppPage, action: PageAction | null, resultStatus: string): boolean {
  return resultStatus === "APPLIED" && action !== null && ["click", "fill"].includes(action.type) &&
    page.controls.some((control) => control.permission === "human" && /^(?:本人)?确认|授权并执行/u.test(control.label));
}
