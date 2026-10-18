import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "./auth";
import { applyConversationPreference } from "./conversation-preferences";
import { clearPreferences, deletePreference, getPreferenceState, savePreference, setPreferenceMemoryEnabled } from "./visitor-preferences";

vi.mock("./visitor-preferences", () => ({
  getPreferenceState: vi.fn(), savePreference: vi.fn(), deletePreference: vi.fn(),
  clearPreferences: vi.fn(), setPreferenceMemoryEnabled: vi.fn(),
}));

const scope = { ownerId: "visitor-a", profileKey: "demo-a" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPreferenceState).mockResolvedValue({ enabled: true, version: "7", preferences: {}, retainedCount: 0 });
});

describe("conversation preference persistence", () => {
  it("writes only to the authenticated scope and reports success after commit", async () => {
    const reply = await applyConversationPreference(scope, { kind: "save", key: "preferred_name", value: "小陈" });
    expect(savePreference).toHaveBeenCalledWith(scope, "preferred_name", "小陈", "7", "USER_EXPLICIT");
    expect(reply).toContain("已保存");
  });

  it("does not report success when the database rejects or fails the write", async () => {
    vi.mocked(savePreference).mockRejectedValueOnce(new Error("db unavailable"));
    await expect(applyConversationPreference(scope, { kind: "save", key: "response_language", value: "en" })).rejects.toThrow("db unavailable");
    vi.mocked(savePreference).mockRejectedValueOnce(new AuthError("PREFERENCE_MEMORY_DISABLED", 409));
    expect(await applyConversationPreference(scope, { kind: "save", key: "response_language", value: "en" })).toContain("没有保存");
  });

  it("cannot write without a visitor scope", async () => {
    expect(await applyConversationPreference(null, { kind: "clear" })).toContain("没有保存或删除");
    expect(getPreferenceState).not.toHaveBeenCalled();
  });

  it("deletes, clears and toggles the current scope using its version", async () => {
    await applyConversationPreference(scope, { kind: "delete", key: "preferred_name" });
    await applyConversationPreference(scope, { kind: "clear" });
    await applyConversationPreference(scope, { kind: "disable" });
    await applyConversationPreference(scope, { kind: "enable" });
    expect(deletePreference).toHaveBeenCalledWith(scope, "preferred_name", "7");
    expect(clearPreferences).toHaveBeenCalledWith(scope, "7");
    expect(setPreferenceMemoryEnabled).toHaveBeenNthCalledWith(1, scope, false, "7");
    expect(setPreferenceMemoryEnabled).toHaveBeenNthCalledWith(2, scope, true, "7");
  });
});
