// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingAppAgent, type AppAgentTransport } from "./FloatingAppAgent";
import type { AppAgentView } from "@/lib/app-agent-protocol";
import type { RealtimeVoice } from "@/features/realtime-voice/useRealtimeVoice";

vi.mock("@/lib/app-page", () => ({ captureAppPage: () => ({ name: "首页", version: "v1", text: "", controls: [] }), applyPageAction: vi.fn() }));
vi.mock("@/components/ui/fluid-orb", () => ({ default: () => null }));
const voice = { status: "listening", error: "", caption: "", heard: "查看本月账单", muted: false, seconds: 3, proposal: null as string | null, start: vi.fn(async () => {}), stop: vi.fn(), toggleMute: vi.fn(), interrupt: vi.fn() };
vi.mock("@/features/realtime-voice/useRealtimeVoice", () => ({ useRealtimeVoice: () => voice as unknown as RealtimeVoice }));

let root: Root;
let container: HTMLDivElement;
const request = vi.fn(async (body: Record<string, unknown>): Promise<AppAgentView> => ({ id: "0e064f38-7258-44c5-bdd8-e256c10aa007", status: "COMPLETED", message: `请核对页面回执：${body.command}`, pending: null, controlGranted: false, steps: 1,
  timeline: [{ id: "event-1", sequence: 1, at: "2026-10-17T00:00:00.000Z", title: "Blank 本轮结束", state: "done", detail: "请以页面回执为准。" }] }));
const transport: AppAgentTransport = { request, restore: async () => { throw new Error("none"); }, storageKey: "test-floating-voice" };
const render = (voiceEnabled: boolean) => act(async () => root.render(<FloatingAppAgent rootRef={{ current: container }} configured voiceEnabled={voiceEnabled} openSignal={1} transport={transport} />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockClear(); voice.start.mockClear(); voice.stop.mockClear(); voice.proposal = null;
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("live floating assistant voice", () => {
  it("hides the call entry when realtime voice is not configured", async () => {
    await render(false);
    expect(container.querySelector('button[aria-label="开始语音通话"]')).toBeNull();
  });
  it("requires the user to continue a voice proposal before a task starts", async () => {
    await render(true);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="开始语音通话"]')?.click());
    expect(voice.start).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="region"][aria-label="实时语音通话"]')).not.toBeNull();
    expect(container.textContent).toContain("查看本月账单");
    expect(request).not.toHaveBeenCalled();
    voice.proposal = "查看本月账单";
    await render(true);
    const proceed = [...container.querySelectorAll("button")].find(item => item.textContent === "继续办理");
    await act(async () => proceed?.click());
    expect(voice.stop).toHaveBeenCalled();
    expect(container.querySelector('[aria-label="实时语音通话"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ command: "start", message: "查看本月账单" });
  });
});
