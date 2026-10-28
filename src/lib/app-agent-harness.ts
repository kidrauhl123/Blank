import { ChatOpenAI } from "@langchain/openai";
import { ChatDeepSeek } from "@langchain/deepseek";
import { HumanMessage } from "@langchain/core/messages";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import { createDeepAgent, registerHarnessProfile } from "deepagents";
import { createMiddleware, modelCallLimitMiddleware } from "langchain";
import { z } from "zod";
import { AIConfigurationError, getAIStatus } from "./ai";
import { actionResultSchema, type PageAction } from "./app-agent-protocol";
import { appAgentSkillFiles } from "./app-agent-skills";
import { APP_AGENT_PROMPT } from "./bank-agent-prompts";
import { currentPreferenceData, currentPreferenceScope } from "./preference-runtime";
import { recipeSchema } from "./feed-recipe";
import { deleteRecipe, listRecipes, previewRecipe, saveRecipe } from "./feed-recipe-store";
import { investmentFiltersSchema, listInvestmentProducts } from "./investments";

import { readBankFacts } from "./bank-agent-facts";

export { APP_AGENT_PROMPT } from "./bank-agent-prompts";

function bridge(action: PageAction, runtime: ToolRuntime) {
  const result = interrupt({ kind: "APP_PAGE_ACTION", id: runtime.toolCallId, action });
  return JSON.stringify(actionResultSchema.parse(result));
}
const description = z.string().min(1).max(200).describe("向用户展示本步要做什么");
const pageVersion = z.string().max(40).describe("最新页面快照 version，页面变化后重新读取");
const target = z.string().max(120).describe("最新页面 controls 中的 id，不是 CSS 选择器");
const cardId = z.string().uuid().describe("preview_feed_card 返回的 cardId");

// 卡片配方只属于当前访客（演示账户由访客共用）；没有访客身份时不能创建。
function cardOwner(runtime: ToolRuntime) {
  const customerId = runtime.config.configurable?.bank_customer_id;
  if (typeof customerId !== "string") throw new Error("BANK_APP_SESSION_REQUIRED");
  const scope = currentPreferenceScope();
  if (!scope) throw new Error("卡片需要访客身份，请刷新页面后重试");
  return { customerId, ownerId: scope.ownerId };
}

export function appPageTools() {
  return [
    tool(async (input, runtime: ToolRuntime) => {
      const customerId = runtime.config.configurable?.bank_customer_id;
      if (typeof customerId !== "string") throw new Error("BANK_APP_SESSION_REQUIRED");
      return JSON.stringify(await readBankFacts(customerId, input.area, input.month));
    }, {
      name: "read_bank_facts",
      description: "直接查询当前客户余额、卡片、近期流水与订阅(overview)，完整月度账单及分类汇总(statement)，或理财持仓(investments)。无需打开或操作页面。金额单位为分；近期流水不代表完整账单。",
      schema: z.object({ area: z.enum(["overview", "statement", "investments"]), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("statement 的 YYYY-MM 月份，省略查询本月。其他 area 不使用。") }),
    }),
    tool(async (input, runtime: ToolRuntime) => {
      const customerId = runtime.config.configurable?.bank_customer_id;
      if (typeof customerId !== "string") throw new Error("BANK_APP_SESSION_REQUIRED");
      const result = await listInvestmentProducts(customerId, input);
      return JSON.stringify({ ...result, products: result.products.map(product => ({ ...product, history: undefined })),
        scope: "产品来自本项目目录；历史净值变化不是预期收益。候选筛选不等于风险测评或申购授权。" });
    }, { name: "search_investment_products", description: "查询当前客户理财日期下的产品，可按金额、风险、持有期限和类型筛选。返回产品事实、费用及净值，不进行交易。", schema: investmentFiltersSchema }),
    tool(async (input, runtime: ToolRuntime) => {
      const { customerId, ownerId } = cardOwner(runtime);
      const { id, post, values } = await previewRecipe(customerId, ownerId, input);
      return JSON.stringify({ cardId: id, marker: `[[card:${id}]]`, headline: post.title, values,
        instruction: "接着调用 ask_user：question 以 marker 开头（原样写出，用户会看到卡片预览），再用一句话说明这张卡看什么、多久发一次，不要写金额（数字都在卡片上）；options 用“加入动态”“再改改”“算了”。用户选择加入后调用 save_feed_card。金额单位为分。" });
    }, { name: "preview_feed_card", description: "按用户描述设计一张动态卡片并生成预览（不会发布）。配方只描述看哪些流水、用哪些积木、多久发一次；数字由服务端按账本计算。", schema: recipeSchema }),
    tool(async (input, runtime: ToolRuntime) => {
      const { customerId, ownerId } = cardOwner(runtime);
      return JSON.stringify(await saveRecipe(customerId, ownerId, input.cardId, input.replaces));
    }, { name: "save_feed_card", description: "用户明确同意后，把预览过的卡片加入用户的动态，并立刻发出第一条。修改已有卡片时传 replaces=旧 cardId。不知道 cardId 时省略，会保存用户最近一次预览。", schema: z.object({ cardId: cardId.optional(), replaces: cardId.optional() }) }),
    tool(async (_, runtime: ToolRuntime) => {
      const { customerId, ownerId } = cardOwner(runtime);
      return JSON.stringify({ cards: await listRecipes(customerId, ownerId) });
    }, { name: "list_feed_cards", description: "列出用户自己创建、正在生效的动态卡片。", schema: z.object({}) }),
    tool(async (input, runtime: ToolRuntime) => {
      const { customerId, ownerId } = cardOwner(runtime);
      return JSON.stringify({ deleted: await deleteRecipe(customerId, ownerId, input.cardId) });
    }, { name: "delete_feed_card", description: "删除用户自己创建的一张动态卡片及它发过的帖子。", schema: z.object({ cardId }) }),
    tool((_, runtime: ToolRuntime) => bridge({ type: "inspect", description: "正在查看当前页面" }, runtime), {
      name: "inspect_page", description: "读取用户正在看的 BankPilot 页面、可见数据及可用控件。不会读取密码或验证码。", schema: z.object({}),
    }),
    tool((input, runtime: ToolRuntime) => bridge({ type: "click", ...input }, runtime), {
      name: "click_control", description: "点击已注册的页面控件。human 控件只可交给用户，不可代点。", schema: z.object({ target, pageVersion, description }),
    }),
    tool((input, runtime: ToolRuntime) => bridge({ type: "fill", ...input }, runtime), {
      name: "fill_control", description: "填写当前页面普通表单字段，不能填写密码、验证码或确认授权。", schema: z.object({ target, value: z.string().max(200), pageVersion, description }),
    }),
    tool((input, runtime: ToolRuntime) => bridge({ type: "scroll", ...input }, runtime), {
      name: "scroll_page", description: "滚动用户正在看的银行页面。", schema: z.object({ direction: z.enum(["up", "down"]), pageVersion, description }),
    }),
    tool((input, runtime: ToolRuntime) => bridge({ type: "question", ...input }, runtime), {
      name: "ask_user", description: "有歧义或缺少信息时展示选择题。用户也可以自由输入；回答不属于银行授权。", schema: z.object({ question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(100)).min(2).max(4) }),
    }),
    tool((input, runtime: ToolRuntime) => bridge({ type: "handoff", ...input }, runtime), {
      name: "handoff_to_user", description: "在业务确认、强验证或其他必须由用户操作的步骤暂停。用户操作后可继续并查看真实状态。", schema: z.object({ description: z.string().min(1).max(300) }),
    }),
  ];
}

export function createAppAgentHarness(checkpointer: BaseCheckpointSaver, modelOverride?: ChatOpenAI | ChatDeepSeek, selectedModel?: string, streaming = false) {
  if (!modelOverride && !getAIStatus().configured) throw new AIConfigurationError();
  const modelName = modelOverride?.model ?? selectedModel ?? process.env.AI_MODEL!;
  const deepseek = modelOverride ? modelOverride instanceof ChatDeepSeek : new URL(process.env.AI_BASE_URL!).hostname === "api.deepseek.com";
  const deepseekModel = deepseek || /^deepseek[-/]/i.test(modelName);
  // No operating-system backend, sandbox, Shell, network or delegated agents.
  registerHarnessProfile(`${deepseek ? "deepseek" : "openai"}:${modelName}`, {
    excludedTools: ["write_file", "edit_file", "delete_file", "execute", "eval", "task", "glob", "grep", "ls"],
    generalPurposeSubagent: { enabled: false },
  });
  const modelOptions = {
    model: modelName, apiKey: process.env.AI_API_KEY!,
    configuration: { baseURL: process.env.AI_BASE_URL?.replace(/\/$/, "") },
    streaming,
    temperature: 0, maxTokens: 4096, maxRetries: 0, timeout: Number(process.env.AI_TIMEOUT_MS ?? 30000),
    // DeepSeek defaults to thinking mode, whose tool turns require replaying
    // reasoning_content. The installed provider adapter does not serialize it
    // back to messages, so use the documented non-thinking mode for page tools.
    modelKwargs: { parallel_tool_calls: false, ...(deepseekModel ? { thinking: { type: "disabled" } } : {}) },
  };
  const model = modelOverride ?? (deepseek ? new ChatDeepSeek(modelOptions) : new ChatOpenAI(modelOptions));
  // The SDK's profile resolver currently reads modelName, whereas ChatOpenAI
  // exposes model. Supply the alias; enforce an independent allowlist as well.
  Object.defineProperty(model, "modelName", { value: modelName, configurable: true });
  const allowed = new Set([...appPageTools().map((entry) => entry.name), "read_file"]);
  const boundary = createMiddleware({
    name: "BankPageToolBoundary",
    wrapModelCall: async (request, handler) => {
      const data = await currentPreferenceData();
      return handler({ ...request,
        messages: data ? [new HumanMessage(data), ...request.messages] : request.messages,
        tools: request.tools.filter((entry) => "name" in entry && typeof entry.name === "string" && allowed.has(entry.name)),
      });
    },
    wrapToolCall: (request, handler) => {
      if (!allowed.has(request.toolCall.name)) throw new Error("APP_AGENT_TOOL_NOT_ALLOWED");
      if (request.toolCall.name === "read_file" && !Object.hasOwn(appAgentSkillFiles(), String(request.toolCall.args.file_path))) throw new Error("APP_AGENT_SKILL_NOT_ALLOWED");
      return handler(request);
    },
  });
  return createDeepAgent({
    model, name: "bankpilot-app-agent", tools: appPageTools(),
    systemPrompt: APP_AGENT_PROMPT, skills: ["/skills/"], checkpointer, subagents: [],
    permissions: [
      { operations: ["read"], paths: ["/skills/**"], mode: "allow" },
      { operations: ["read", "write"], paths: ["/**"], mode: "deny" },
    ],
    middleware: [boundary, modelCallLimitMiddleware({ threadLimit: 40, runLimit: 8, exitBehavior: "error" })],
  });
}
