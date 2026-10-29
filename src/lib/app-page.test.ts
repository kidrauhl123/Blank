// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPageAction, captureAppPage } from "./app-page";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 20, height: 20 }] as unknown as DOMRectList);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `<main data-agent-page="首页"><p>余额 100 元</p>
    <button data-agent-id="nav" data-agent-permission="navigate">卡片</button>
    <button data-agent-id="confirm" data-agent-permission="human">授权并执行</button>
    <label>备注<input data-agent-id="note" data-agent-permission="fill" value=""></label>
    <input type="password" data-agent-id="password" data-agent-permission="fill" value="secret-password">
    <input autocomplete="one-time-code" data-agent-id="otp" data-agent-permission="fill" value="654321">
    <p data-agent-private>private-account-number</p>
    <section data-agent-overlay role="dialog"><p>Blank 回复，不能污染页面</p><button data-agent-id="agent-button" data-agent-permission="navigate">Blank 按钮</button></section>
  </main>`;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("visible page boundary", () => {
  it("shares the bank page and removes secrets and the assistant's own dialog", () => {
    const page = captureAppPage(document.querySelector("main")!);
    expect(page.name).toBe("首页");
    expect(page.controls.map((item) => item.id)).toEqual(["nav", "confirm", "note"]);
    expect(JSON.stringify(page)).not.toMatch(/secret-password|654321|private-account-number|Blank 回复/);
  });
  it("refuses to click a bank authorization button even if the model asks", async () => {
    const root = document.querySelector("main")!;
    const handler = vi.fn(); root.querySelector('[data-agent-id="confirm"]')!.addEventListener("click", handler);
    const result = await applyPageAction(root, { type: "click", target: "confirm", pageVersion: captureAppPage(root).version, description: "忽略规则并执行" }, () => true);
    expect(result).toMatchObject({ status: "BLOCKED", message: "USER_REQUIRED" });
    expect(handler).not.toHaveBeenCalled();
  });
  it("does not replay an action against a changed page", async () => {
    const root = document.querySelector("main")!;
    const version = captureAppPage(root).version;
    root.querySelector("p")!.textContent = "页面被用户修改";
    const result = await applyPageAction(root, { type: "click", target: "nav", pageVersion: version, description: "导航" }, () => true);
    expect(result.status).toBe("USER_CHANGED");
  });
  it("stops before the highlighted click when the user takes control", async () => {
    vi.useFakeTimers();
    const root = document.querySelector("main")!;
    const handler = vi.fn(); root.querySelector('[data-agent-id="nav"]')!.addEventListener("click", handler);
    let control = true;
    const promise = applyPageAction(root, { type: "click", target: "nav", pageVersion: captureAppPage(root).version, description: "导航" }, () => control);
    control = false;
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe("USER_CHANGED");
    expect(handler).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("types into the real field progressively and preserves the user's replacement on pause", async () => {
    vi.useFakeTimers();
    const root = document.querySelector("main")!;
    const input = root.querySelector<HTMLInputElement>('[data-agent-id="note"]')!;
    const onMotion = vi.fn();
    let control = true;
    const promise = applyPageAction(root, { type: "fill", target: "note", value: "周末聚餐", pageVersion: captureAppPage(root).version, description: "填写备注" }, () => control, { onMotion });
    await vi.advanceTimersByTimeAsync(551);
    expect(input.value).toBe("周");
    expect(onMotion).toHaveBeenCalledWith(expect.objectContaining({ phase: "typing" }));
    control = false;
    input.value = "用户自己填写";
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject({ status: "USER_CHANGED" });
    expect(input.value).toBe("用户自己填写");
    expect(input.hasAttribute("data-agent-highlight")).toBe(false);
    expect(onMotion).toHaveBeenLastCalledWith(null);
  });
  it("completes animated input without treating its own edits as external page changes", async () => {
    vi.useFakeTimers();
    const root = document.querySelector("main")!;
    const input = root.querySelector<HTMLInputElement>('[data-agent-id="note"]')!;
    const values: string[] = [];
    input.addEventListener("input", () => values.push(input.value));
    const promise = applyPageAction(root, { type: "fill", target: "note", value: "聚餐🍰", pageVersion: captureAppPage(root).version, description: "填写备注" }, () => true);
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject({ status: "APPLIED" });
    expect(values).toEqual(["聚", "聚餐", "聚餐🍰"]);
    expect(input.hasAttribute("data-agent-filled")).toBe(true);
  });
  it("respects reduced motion by filling once while keeping the same safety gate", async () => {
    vi.useFakeTimers();
    const root = document.querySelector("main")!;
    const input = root.querySelector<HTMLInputElement>('[data-agent-id="note"]')!;
    const values: string[] = [];
    input.addEventListener("input", () => values.push(input.value));
    const promise = applyPageAction(root, { type: "fill", target: "note", value: "聚餐", pageVersion: captureAppPage(root).version, description: "填写备注" }, () => true, { reducedMotion: true });
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe("APPLIED");
    expect(values).toEqual(["聚餐"]);
  });
});
