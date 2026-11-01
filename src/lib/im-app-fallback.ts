// IM（QQ、企业微信）走自己的工作流，没有页面，也不能代客户完成需要确认的页面操作。
// 这里先认出只能在 App 里完成的请求，直接说明并给出“回 App 继续”的链接，不尝试执行，也不让模型去猜。
// 简单的查询和锁卡等已经支持的操作仍然走原来的流程。
export type AppOnlyRequest = { feature: string; path: string };

const RULES: Array<{ pattern: RegExp; feature: string; path: string }> = [
  { pattern: /立规矩|免确认|不用问我|自动(转|付)/, feature: "立规矩（免确认的小额付款规则）", path: "/rules" },
  { pattern: /做法|记成.{0,4}(流程|步骤)|保存.{0,4}(流程|步骤)/, feature: "做法（以后一句话就能触发的办事步骤）", path: "/skills" },
  { pattern: /互联|邀请.{0,6}(家人|朋友|妈妈|爸爸|孩子)|接受邀请/, feature: "家人与朋友互联", path: "/links" },
  { pattern: /(改|设置|调整|换|做).{0,4}(首页|底部导航|页面|布局)|(首页|底部导航|页面|布局).{0,6}(改|换|调整|只留)|做一个.{0,4}页面/, feature: "首页和页面设置", path: "/" },
  { pattern: /做一个.{0,4}(工具|模拟器|分账表)|滑块/, feature: "交互小工具", path: "/" },
  { pattern: /申购|赎回|买理财|买入理财|卖出理财/, feature: "理财申购和赎回（需要本人确认和验证）", path: "/" },
  { pattern: /取号|预约网点|换汇预约|预约换汇/, feature: "网点预约", path: "/" },
  { pattern: /定时|每(天|周|月).{0,4}(提醒|给我)|提醒我/, feature: "定时任务和提醒", path: "/schedules" },
];

export function appOnlyRequest(text: string): AppOnlyRequest | null {
  const hit = RULES.find(rule => rule.pattern.test(text));
  return hit ? { feature: hit.feature, path: hit.path } : null;
}

// 回复的固定文字：说明功能只能在 App 里完成，并给出链接。链接由服务端的公开地址拼出。
export function appFallbackMessage(request: AppOnlyRequest, publicUrl: string) {
  return `「${request.feature}」需要在 Blank App 里完成，本人确认后才会生效。回 App 继续：${publicUrl}${request.path}`;
}
