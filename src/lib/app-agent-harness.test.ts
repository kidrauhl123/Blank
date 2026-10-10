import { describe, expect, it } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { Command, INTERRUPT, MemorySaver } from "@langchain/langgraph";
import { createAppAgentHarness } from "./app-agent-harness";
import { appAgentSkillFiles } from "./app-agent-skills";
import type { AppPage } from "./app-agent-protocol";

const page: AppPage = { name: "首页", version: "p1", text: "测试银行", controls: [{ id: "nav-cards", label: "卡片", kind: "button", permission: "navigate", disabled: false }] };
function pending(result: unknown) {
  return (result as Record<string, Array<{ value: { id: string; action: { type: string } } }>>)[INTERRUPT][0].value;
}

describe("real Deep Agents harness, with a deterministic model transport", () => {
  it("executes multiple Skill reads before advancing to the requested page action", async () => {
    let calls = 0;
    const model = new ChatOpenAI({ model: "parallel-skill-test", apiKey: "test-only", maxRetries: 0, configuration: {
      baseURL: "https://test.invalid/v1", fetch: async () => {
        const tools = ++calls === 1 ? ["bank-card", "bank-page"].map((name, index) => ({ id: `skill_${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ file_path: `/skills/${name}/SKILL.md`, offset: 0, limit: 1000 }) } }))
          : [{ id: "open_cards", type: "function", function: { name: "click_control", arguments: JSON.stringify({ target: "nav-cards", pageVersion: "p1", description: "打开卡片" }) } }];
        return new Response(JSON.stringify({ id: "skills-completion", object: "chat.completion", created: 1, model: "parallel-skill-test",
          choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: tools } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }), { headers: { "Content-Type": "application/json" } });
      },
    } });
    const graph = createAppAgentHarness(new MemorySaver(), model);
    const result = await graph.invoke({ messages: [{ role: "user", content: JSON.stringify(page) }], files: appAgentSkillFiles() }, { configurable: { thread_id: "parallel-skills" }, maxConcurrency: 4 });
    expect(calls).toBe(2);
    expect(pending(result)).toMatchObject({ action: { type: "click", target: "nav-cards" } });
  });
  it("discovers standard Skills, pauses page tools and feeds changed state back to the model", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const actions = [
      { name: "click_control", args: { target: "nav-cards", pageVersion: "p1", description: "打开卡片管理" } },
      { name: "ask_user", args: { question: "你想查看哪张卡？", options: ["日常卡 1234", "旅行卡 5678"] } },
    ];
    const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const action = actions[requests.length - 1];
      return new Response(JSON.stringify({
        id: "completion-test", object: "chat.completion", created: 1, model: "bank-test-model",
        choices: [{ index: 0, finish_reason: action ? "tool_calls" : "stop", message: action
          ? { role: "assistant", content: "", tool_calls: [{ id: `call_${requests.length}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] }
          : { role: "assistant", content: "已选择日常卡，尚未提交任何银行操作。" } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }), { headers: { "Content-Type": "application/json" } });
    };
    const model = new ChatOpenAI({ model: "bank-test-model", apiKey: "test-only", maxRetries: 0, configuration: { baseURL: "https://test.invalid/v1", fetch } });
    const agent = createAppAgentHarness(new MemorySaver(), model);
    const config = { configurable: { thread_id: "test-app-agent" }, maxConcurrency: 1 };
    const first = await agent.invoke({ messages: [{ role: "user", content: JSON.stringify(page) }], files: appAgentSkillFiles() }, config);
    expect(pending(first)).toMatchObject({ id: "call_1", action: { type: "click", target: "nav-cards" } });
    expect(requests).toHaveLength(1);
    const initialPrompt = JSON.stringify(requests[0].messages);
    expect(initialPrompt).toContain("bank-card");
    expect(initialPrompt).toContain("/skills/bank-card/SKILL.md");
    const toolNames = (requests[0].tools as Array<{ function: { name: string } }>).map((item) => item.function.name);
    expect(toolNames).toContain("read_file");
    for (const forbidden of ["execute", "eval", "task", "write_file", "edit_file"]) expect(toolNames).not.toContain(forbidden);
    const second = await agent.invoke(new Command({ resume: { status: "APPLIED", message: "已打开卡片页", page: { ...page, name: "卡片管理", version: "p2", text: "日常卡 1234、旅行卡 5678" } } }), config);
    expect(pending(second)).toMatchObject({ id: "call_2", action: { type: "question", options: ["日常卡 1234", "旅行卡 5678"] } });
    expect(JSON.stringify(requests[1].messages)).toContain("旅行卡 5678");
    const third = await agent.invoke(new Command({ resume: { status: "USER_ANSWERED", message: "日常卡 1234", page } }), config);
    expect((third as unknown as Record<string, unknown>)[INTERRUPT]).toBeUndefined();
    expect(JSON.stringify(requests[2].messages)).toContain("USER_ANSWERED");
  });
});
