// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingAppAgent, type AppAgentTransport } from "./FloatingAppAgent";
import type { AppAgentView } from "@/lib/app-agent-protocol";

vi.mock("@/lib/app-page", () => ({ captureAppPage: () => ({ name: "首页", version: "v1", text: "", controls: [] }), applyPageAction: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
const request = vi.fn(async (body: Record<string, unknown>): Promise<AppAgentView> => ({ id: "0e064f38-7258-44c5-bdd8-e256c10aa007", status: "COMPLETED", message: `请核对页面回执：${body.command}`, pending: null, controlGranted: false, steps: 1,
  timeline: [{ id: "event-1", sequence: 1, at: "2026-10-17T00:00:00.000Z", title: "助手本轮结束", state: "done", detail: "请以页面回执为准。" }] }));
const transport: AppAgentTransport = { request, restore: async () => { throw new Error("none"); }, storageKey: "test-floating-voice" };

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockClear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<FloatingAppAgent rootRef={{ current: container }} configured openSignal={1} transport={transport} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("live floating assistant voice", () => {
  it("requires a manual send after recognized text reaches the existing draft", async () => {
    let emitResult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | undefined;
    let emitEnd: (() => void) | undefined;
    class Recognition {
      lang = ""; interimResults = false; maxAlternatives = 0;
      onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() { emitResult = (event) => this.onresult?.(event); emitEnd = () => this.onend?.(); }
      stop() { this.onend?.(); }
      abort() { /* browser stub */ }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: Recognition, configurable: true });
    const mic = container.querySelector<HTMLButtonElement>('button[aria-label="语音输入"]');
    await act(async () => mic?.click());
    await act(async () => { emitResult?.({ results: [[{ transcript: "查看本月账单" }]] }); emitEnd?.(); });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="向悬浮助手描述需求或回答问题"]');
    expect(input?.value).toBe("查看本月账单");
    expect(request).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="发送给悬浮助手"]')?.click(); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ command: "start", message: "查看本月账单" });
    expect(container.textContent).toContain("助手本轮结束");
  });
});
