// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/client-request", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/client-request")>()), bankRequest: mocks.request }));

import { BankRequestError } from "@/lib/client-request";
import { PreferenceSettings } from "./PreferenceSettings";

const initial = { enabled: true, version: "0", preferences: {}, retainedCount: 0, scopeTag: "scope-a" };
let root: Root;
let container: HTMLDivElement;

async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); }
function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
function typeName(value: string) {
  const input = container.querySelector<HTMLInputElement>("#preference-preferred_name")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  mocks.request.mockResolvedValue(initial);
  await act(async () => { root.render(<PreferenceSettings />); });
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("preference settings", () => {
  it("saves a name with the visible version and confirms only after the server reply", async () => {
    await act(async () => typeName("小陈"));
    mocks.request.mockResolvedValueOnce({ enabled: true, version: "1", retainedCount: 1, scopeTag: "scope-a",
      preferences: { preferred_name: { value: "小陈", source: "USER_SETTINGS", version: "1", updatedAt: "2026-10-17T00:00:00Z", expiresAt: "2027-01-15T00:00:00Z" } } });
    await act(async () => click("保存"));
    expect(mocks.request).toHaveBeenCalledWith("/api/v1/preferences", expect.objectContaining({ method: "PUT" }));
    const body = JSON.parse((mocks.request.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ key: "preferred_name", value: "小陈", expectedVersion: "0", expectedScope: "scope-a" });
    expect(container.textContent).toContain("偏好已保存");
  });

  it("keeps disable separate from clearing retained preferences", async () => {
    mocks.request.mockResolvedValueOnce({ enabled: false, version: "1", preferences: {}, retainedCount: 1, scopeTag: "scope-a" });
    await act(async () => click("关闭记忆"));
    expect(JSON.parse((mocks.request.mock.calls.at(-1)![1] as RequestInit).body as string)).toEqual({ enabled: false, expectedVersion: "0", expectedScope: "scope-a" });
    expect(container.textContent).toContain("仍保留 1 项");
    expect(container.querySelector("#preference-preferred_name")).toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.request.mockResolvedValueOnce({ enabled: false, version: "2", preferences: {}, retainedCount: 0, scopeTag: "scope-a" });
    await act(async () => click("清空全部偏好"));
    expect(JSON.parse((mocks.request.mock.calls.at(-1)![1] as RequestInit).body as string)).toEqual({ all: true, expectedVersion: "1", expectedScope: "scope-a" });
    expect(container.textContent).toContain("偏好已清空");
  });

  it("reloads a conflicting version without retrying the write", async () => {
    await act(async () => typeName("小陈"));
    mocks.request.mockRejectedValueOnce(new BankRequestError("偏好已在别处更新", false, 409));
    mocks.request.mockResolvedValueOnce({ enabled: true, version: "2", preferences: {}, retainedCount: 0, scopeTag: "scope-a" });
    await act(async () => click("保存"));
    expect(mocks.request.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT")).toHaveLength(1);
    expect(container.textContent).toContain("已重新读取");
  });
});
