import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

const mocks = vi.hoisted(() => ({ active: vi.fn() }));
vi.mock("./visitor-preferences", () => ({ getActivePreferenceValues: mocks.active }));

import { understandWithAI } from "./ai";
import { createAppAgentHarness } from "./app-agent-harness";
import { withPreferenceScope } from "./preference-runtime";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); mocks.active.mockReset(); });

describe("model-call preference injection", () => {
  it("sends data to the planner only for the current visitor", async () => {
    vi.stubEnv("AI_BASE_URL", "https://model.invalid/v1");
    vi.stubEnv("AI_API_KEY", "test-only");
    vi.stubEnv("AI_MODEL", "test-model");
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ intent: "BALANCE", confidence: 1,
        entities: { beneficiaryName: null, amountMinor: null, accountName: null, timeRange: null }, steps: ["read_accounts"], clarification: null }) } }] });
    }));
    mocks.active.mockResolvedValueOnce({ response_language: "en" });
    await withPreferenceScope({ ownerId: "a", profileKey: "demo" }, () => understandWithAI("查余额", []));
    await understandWithAI("查余额", []);
    const first = requests[0] as { messages: Array<{ role: string; content: string }> };
    const second = requests[1] as { messages: Array<{ role: string; content: string }> };
    expect(first.messages[1].content).toContain('"response_language":"en"');
    expect(second.messages.filter((message) => message.role === "user").map((message) => message.content)).not.toContainEqual(expect.stringContaining("PREFERENCE_DATA"));
    expect(mocks.active).toHaveBeenCalledTimes(1);
  });

  it("keeps page-agent preference data out of its persisted checkpoint", async () => {
    const requests: unknown[] = [];
    const model = new ChatOpenAI({ model: "preference-test", apiKey: "test-only", maxRetries: 0, configuration: {
      baseURL: "https://model.invalid/v1", fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "preference-reply", object: "chat.completion", created: 1, model: "preference-test",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "您好。" } }] });
      },
    } });
    const graph = createAppAgentHarness(new MemorySaver(), model);
    const config = { configurable: { thread_id: "preference-a" }, maxConcurrency: 4 };
    mocks.active.mockResolvedValueOnce({ preferred_name: "小陈" });
    await withPreferenceScope({ ownerId: "a", profileKey: "demo" }, () => graph.invoke({ messages: [{ role: "user", content: "你好" }] }, config));
    const first = requests[0] as { messages: Array<{ role: string; content: string }> };
    expect(first.messages.filter((message) => message.role === "user").map((message) => message.content)).toContainEqual(expect.stringContaining("小陈"));
    const state = await graph.getState(config) as unknown as { values: unknown };
    expect(JSON.stringify(state.values)).not.toContain("PREFERENCE_DATA");
    expect(JSON.stringify(state.values)).not.toContain("小陈");
    await graph.invoke({ messages: [{ role: "user", content: "你好" }] }, { configurable: { thread_id: "preference-none" }, maxConcurrency: 4 });
    const second = requests[1] as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.filter((message) => message.role === "user").map((message) => message.content)).not.toContainEqual(expect.stringContaining("PREFERENCE_DATA"));
  });
});
