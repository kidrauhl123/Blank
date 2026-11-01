import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeFeedCandidate, FEED_SHOW_THRESHOLD } from "./jev";

const candidate = { id: "anomaly:1", kind: "anomaly", title: "这笔 ¥3,999 和你平时不太一样", body: "澄光数码 ¥3,999，比平时高很多。", attention: true };
const reply = (noul: number) => new Response(JSON.stringify({
  model: "jev-test", answers: { worth_showing: { type: "noul", noul } }, usage: { input_tokens: 10, output_tokens: 2 },
}), { status: 200, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("judgeFeedCandidate：动态候选的门控", () => {
  it("没有配置 Jev 时直接拒绝（失败即关闭），不会发出任何请求", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(judgeFeedCandidate(candidate)).rejects.toThrow("JEV_NOT_CONFIGURED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("概率达到阈值才显示，低于阈值不显示", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => reply(FEED_SHOW_THRESHOLD)));
    expect(await judgeFeedCandidate(candidate)).toMatchObject({ show: true, probability: FEED_SHOW_THRESHOLD });
    vi.stubGlobal("fetch", vi.fn(async () => reply(FEED_SHOW_THRESHOLD - 0.01)));
    expect(await judgeFeedCandidate(candidate)).toMatchObject({ show: false });
  });

  it("返回格式不对、或服务报错，都抛出错误（由调用方当作不发）", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(judgeFeedCandidate(candidate)).rejects.toThrow("JEV_RESPONSE_INVALID");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(judgeFeedCandidate(candidate)).rejects.toThrow("JEV_HTTP_503");
  });
});
