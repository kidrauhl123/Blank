// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingAppAgent, type AppAgentTransport } from "./FloatingAppAgent";
import type { AppAgentView } from "@/lib/app-agent-protocol";

vi.mock("@/lib/app-page", () => ({ captureAppPage: () => ({ name: "首页", version: "v1", text: "", controls: [] }), applyPageAction: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const request = vi.fn(async (): Promise<AppAgentView> => ({ id: "assistant-page-run", status: "COMPLETED", message: "已读取银行页面，请核对回执。", pending: null, controlGranted: false, steps: 1 }));
const transport: AppAgentTransport = { request, restore: async () => { throw new Error("none"); }, storageKey: "assistant-page-test" };
const render = (openSignal: number, closeSignal = 0) => act(async () => root.render(<FloatingAppAgent presentation="page" rootRef={{ current: container }} configured openSignal={openSignal} closeSignal={closeSignal} transport={transport} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear(); request.mockClear(); Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("bottom navigation assistant page", () => {
  it("opens a conversation region without automatically starting a task", async () => {
    await render(1);
    expect(container.querySelector('[role="region"][aria-label="AI 助手会话"]')).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-label="返回银行页面"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps the conversation when switching to banking and returning", async () => {
    await render(1);
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === "查一下我的余额")!;
    await act(async () => button.click());
    expect(request).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("已读取银行页面，请核对回执。");
    await render(1, 1);
    expect(container.querySelector('[aria-label="AI 助手会话"]')).toBeNull();
    await render(2, 1);
    expect(container.textContent).toContain("查一下我的余额");
    expect(container.textContent).toContain("已读取银行页面，请核对回执。");
    expect(request).toHaveBeenCalledOnce();
  });
});
