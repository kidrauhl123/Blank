import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("@/lib/demo", () => ({ loginDemoProfile: mocks.login }));
import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.login.mockResolvedValue({ customer: { id: "demo" }, token: "session-token", memoryToken: "visitor-token", expires: new Date("2030-01-01") });
});

describe("demo login visitor credential", () => {
  it("returns the server-issued memory token as a protected cookie without exposing it in JSON", async () => {
    const request = new NextRequest("https://bank.example/api/auth/demo", {
      method: "POST", headers: { origin: "https://bank.example", cookie: "bankpilot_memory_visitor=existing-visitor" },
      body: JSON.stringify({ profileKey: "potato" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mocks.login).toHaveBeenCalledWith(expect.objectContaining({ profileKey: "potato", previousMemoryToken: "existing-visitor" }));
    expect(response.cookies.get("bankpilot_memory_visitor")?.value).toBe("visitor-token");
    expect(response.headers.get("set-cookie")).toMatch(/bankpilot_memory_visitor=visitor-token.*HttpOnly/);
    expect(await response.json()).toEqual({ customer: { id: "demo" } });
  });
});
