import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ active: vi.fn() }));
vi.mock("./visitor-preferences", () => ({ getActivePreferenceValues: mocks.active }));

import { currentPreferenceData, currentPreferenceScope, withPreferenceScope } from "./preference-runtime";

describe("request-local preference context", () => {
  it("loads current values on every call and stops after deletion or disable", async () => {
    const scope = { ownerId: "owner-a", profileKey: "demo-a" };
    mocks.active.mockResolvedValueOnce({ preferred_name: "小陈", response_detail: "brief" }).mockResolvedValueOnce({});
    await withPreferenceScope(scope, async () => {
      expect(currentPreferenceScope()).toEqual(scope);
      expect(await currentPreferenceData()).toContain('"preferred_name":"小陈"');
      expect(await currentPreferenceData()).toBeNull();
    });
    expect(currentPreferenceScope()).toBeNull();
    expect(await currentPreferenceData()).toBeNull();
    expect(mocks.active).toHaveBeenCalledTimes(2);
  });

  it("does not mix simultaneous visitors", async () => {
    mocks.active.mockImplementation(async (scope: { ownerId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, scope.ownerId === "a" ? 15 : 1));
      return { preferred_name: scope.ownerId === "a" ? "小陈" : "小李" };
    });
    const [a, b] = await Promise.all([
      withPreferenceScope({ ownerId: "a", profileKey: "demo" }, currentPreferenceData),
      withPreferenceScope({ ownerId: "b", profileKey: "demo" }, currentPreferenceData),
    ]);
    expect(a).toContain("小陈");
    expect(a).not.toContain("小李");
    expect(b).toContain("小李");
    expect(b).not.toContain("小陈");
  });
});
