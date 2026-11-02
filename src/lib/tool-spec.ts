import { z } from "zod";

// 当场造工具：Blank 用审核过的“交互积木”在对话里组装一个可交互的小工具。
// 模型只能选积木、填参数和数据范围；所有计算由 tool-calc.ts 的确定性公式在前端完成，基础数据由服务端按账本给出。
// 规格里没有任何文字模板：卡片上的每个数字都是算出来的，标题和备注里不允许出现数字。
const NO_DIGITS = /^[^0-9０-９]*$/;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const sliderSpec = z.object({
  kind: z.literal("slider-simulator"),
  title: z.string().trim().min(1).max(24).regex(NO_DIGITS, "标题里不能写数字").describe("工具标题，例如“冰岛基金提前几个月”"),
  goalLabel: z.string().trim().min(1).max(12).regex(NO_DIGITS, "目标名里不能写数字").describe("攒钱的目标，例如“冰岛”“相机”"),
  targetYuan: z.number().int().min(100).max(10_000_000).describe("目标要花多少钱（元）。用户没说就先问，不要猜"),
  savedYuan: z.number().int().min(0).max(10_000_000).default(0).describe("已经为这个目标攒了多少（元），不知道就是 0"),
  sliderMaxYuan: z.number().int().min(100).max(5000).default(2000).describe("滑块“每月再多存”的最大值（元）"),
  stepYuan: z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(500)]).default(100),
}).strict();

export const splitSpec = z.object({
  kind: z.literal("split-table"),
  title: z.string().trim().min(1).max(24).regex(NO_DIGITS, "标题里不能写数字").describe("工具标题，例如“成都旅行分账”"),
  friend: z.string().trim().min(1).max(12).describe("和谁分账（姓名，必须是演示用户）"),
  from: day.describe("这趟的第一天，YYYY-MM-DD（北京时间）"),
  to: day.describe("这趟的最后一天，YYYY-MM-DD，不早于第一天，跨度不超过 31 天"),
  categories: z.array(z.string().trim().min(1).max(8)).max(6).optional().describe("只列这些分类的支出，例如 餐饮、交通、购物；不写就列全部支出（转账和理财不算）"),
  keywords: z.array(z.string().trim().min(1).max(12)).max(6).optional().describe("商户名包含任一关键词才列出（选填）"),
}).strict().superRefine((spec, ctx) => {
  if (spec.to < spec.from) ctx.addIssue({ code: "custom", message: "最后一天不能早于第一天" });
  else if (Date.parse(`${spec.to}T00:00:00Z`) - Date.parse(`${spec.from}T00:00:00Z`) > 30 * 86_400_000) ctx.addIssue({ code: "custom", message: "分账的时间跨度最多 31 天" });
});

// 根节点带 type: "object"：DeepSeek 等兼容网关遇到没有 type 的根 oneOf 会整包返回 400。.meta() 只并入 JSON Schema，校验结果不变。
export const toolSpecSchema = z.discriminatedUnion("kind", [sliderSpec, splitSpec]).meta({ type: "object" });
export type ToolSpec = z.infer<typeof toolSpecSchema>;
export type SliderSpec = z.infer<typeof sliderSpec>;
export type SplitSpec = z.infer<typeof splitSpec>;

// 服务端读回给前端的数据：规格 + 来自账本的基础数据。前端只用它和 tool-calc.ts 的公式算，不再请求服务端。
export type SplitRow = { id: string; date: string; label: string; amountMinor: number };
export type ToolView = { id: string; saved: boolean; createdAt: string } & (
  | { kind: "slider-simulator"; spec: SliderSpec; base: { monthlyNetMinor: number; monthsObserved: number } }
  | { kind: "split-table"; spec: SplitSpec; rows: SplitRow[]; receivedMinor: number; friendFound: boolean }
);
