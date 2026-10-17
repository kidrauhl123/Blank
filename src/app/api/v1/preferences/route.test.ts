import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(), get: vi.fn(), save: vi.fn(), deleteOne: vi.fn(), clear: vi.fn(), toggle: vi.fn(),
}));
vi.mock("@/lib/visitor-memory", () => ({
  requireVisitorMemoryScope: mocks.scope,
  VISITOR_MEMORY_COOKIE: "bankpilot_memory_visitor",
  visitorMemoryCookieOptions: () => ({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 90 * 86400 }),
}));
vi.mock("@/lib/visitor-preferences", () => ({
  PREFERENCE_KEYS: ["preferred_name", "response_language", "response_detail"],
  getPreferenceState: mocks.get,
  savePreference: mocks.save,
  deletePreference: mocks.deleteOne,
  clearPreferences: mocks.clear,
  setPreferenceMemoryEnabled: mocks.toggle,
}));
import { DELETE, GET, PATCH, PUT } from "./route";

const scope = { ownerId: "server-owner", profileKey: "potato" };
const state = { enabled: true, version: "1", preferences: {}, retainedCount: 0 };
const scopeTag = createHash("sha256").update("bankpilot:preference-scope:v1:visitor-token:server-owner:potato").digest("hex");
const request = (method: string, body?: unknown) => new Request("https://bank.example/api/v1/preferences", {
  method,
  headers: { origin: "https://bank.example", "content-type": "application/json", cookie: "bankpilot_memory_visitor=visitor-token" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue(scope);
  mocks.get.mockResolvedValue(state);
  mocks.save.mockResolvedValue({ state, changedCount: 0 });
  mocks.deleteOne.mockResolvedValue({ state, changedCount: 1 });
  mocks.clear.mockResolvedValue({ state, changedCount: 2 });
  mocks.toggle.mockResolvedValue({ state, changedCount: 0 });
});

describe("preference API contract", () => {
  it("reads only the server-resolved owner and disables caching", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.get).toHaveBeenCalledWith(scope);
    expect(await response.json()).toEqual({ ...state, scopeTag });
  });

  it("accepts a typed save and rejects browser-supplied owner or source", async () => {
    const response = await PUT(request("PUT", { key: "response_detail", value: "brief", expectedVersion: "0", expectedScope: scopeTag }));
    expect(response.status).toBe(200);
    expect(response.cookies.get("bankpilot_memory_visitor")?.value).toBe("visitor-token");
    expect(mocks.save).toHaveBeenCalledWith(scope, "response_detail", "brief", "0");
    const forged = await PUT(request("PUT", { key: "response_detail", value: "brief", expectedVersion: "0", expectedScope: scopeTag, ownerId: "other" }));
    expect(forged.status).toBe(400);
    const forgedSource = await PUT(request("PUT", { key: "response_detail", value: "brief", expectedVersion: "0", expectedScope: scopeTag, source: "PAGE_TEXT" }));
    expect(forgedSource.status).toBe(400);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("requires explicit key or all flag for deletion", async () => {
    const one = await DELETE(request("DELETE", { key: "preferred_name", expectedVersion: "1", expectedScope: scopeTag }));
    expect(await one.json()).toMatchObject({ deletedCount: 1 });
    expect(mocks.deleteOne).toHaveBeenCalledWith(scope, "preferred_name", "1");
    const all = await DELETE(request("DELETE", { all: true, expectedVersion: "2", expectedScope: scopeTag }));
    expect(await all.json()).toMatchObject({ deletedCount: 2 });
    expect(mocks.clear).toHaveBeenCalledWith(scope, "2");
    expect((await DELETE(request("DELETE", { expectedVersion: "2", expectedScope: scopeTag }))).status).toBe(400);
  });

  it("toggles memory with a version and returns a safe conflict", async () => {
    expect((await PATCH(request("PATCH", { enabled: false, expectedVersion: "3", expectedScope: scopeTag }))).status).toBe(200);
    expect(mocks.toggle).toHaveBeenCalledWith(scope, false, "3");
    mocks.toggle.mockRejectedValueOnce(new (await import("@/lib/auth")).AuthError("PREFERENCE_VERSION_CONFLICT", 409));
    const conflict = await PATCH(request("PATCH", { enabled: false, expectedVersion: "3", expectedScope: scopeTag }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe("PREFERENCE_VERSION_CONFLICT");
    expect(conflict.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not reach storage when ownership is unavailable", async () => {
    mocks.scope.mockRejectedValueOnce(new (await import("@/lib/auth")).AuthError("MEMORY_VISITOR_REQUIRED", 403));
    const response = await PUT(request("PUT", { key: "response_detail", value: "brief", expectedVersion: "0", expectedScope: scopeTag }));
    expect(response.status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects a stale settings tab after switching demo profiles even when versions match", async () => {
    mocks.scope.mockResolvedValueOnce({ ownerId: "server-owner", profileKey: "chestnut" });
    const response = await PUT(request("PUT", { key: "response_detail", value: "brief", expectedVersion: "1", expectedScope: scopeTag }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("PREFERENCE_SCOPE_CHANGED");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
