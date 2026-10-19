import { describe, it, expect } from "vitest";
import { nextOccurrence, previousStatementMonth, scheduleInput } from "./schedule-time";
import { assertSchedulerRequest } from "./scheduler-auth";
const date = (value: string) => new Date(value);
describe("schedule calendar", () => {
  it("clamps month-end without drifting the original day, including leap years", () => {
    const start = date("2028-01-31T01:00:00Z");
    expect(nextOccurrence(start, "MONTHLY", start)?.toISOString()).toBe("2028-02-29T01:00:00.000Z");
    expect(nextOccurrence(start, "MONTHLY", date("2028-02-29T01:00:00Z"))?.toISOString()).toBe("2028-03-31T01:00:00.000Z");
    expect(nextOccurrence(date("2027-01-31T01:00:00Z"), "MONTHLY", date("2027-02-01T00:00:00Z"))?.toISOString()).toBe("2027-02-28T01:00:00.000Z");
  });
  it("uses Shanghai date at UTC month boundaries", () => {
    const start = date("2026-01-31T16:30:00Z");
    expect(nextOccurrence(start, "MONTHLY", start)?.toISOString()).toBe("2026-02-28T16:30:00.000Z");
    expect(previousStatementMonth(start)).toBe("2026-01");
    expect(previousStatementMonth(date("2026-12-31T16:00:00Z"))).toBe("2026-12");
  });
  it("skips missed daily/weekly intervals and never repeats a one-off", () => {
    const start = date("2026-01-01T01:00:00Z");
    expect(nextOccurrence(start, "DAILY", date("2026-10-17T02:00:00Z"))?.toISOString()).toBe("2026-10-18T01:00:00.000Z");
    expect(nextOccurrence(start, "WEEKLY", date("2026-01-20T02:00:00Z"))?.toISOString()).toBe("2026-01-22T01:00:00.000Z");
    expect(nextOccurrence(start, "ONCE", start)).toBeNull();
    expect(nextOccurrence(start, "ONCE", date("2025-01-01T00:00:00Z"))).toEqual(start);
  });
  it("rejects unsupported timezones, money actions and unconfirmed tasks", () => {
    const input = { requestKey: "9cc1c55b-e132-4770-a82a-fa53578ee10b", kind: "REMINDER", title: "提醒", message: "查看预算", frequency: "ONCE", startsAt: "2027-01-01T09:00:00+08:00", confirmed: true };
    expect(scheduleInput.safeParse(input).success).toBe(true);
    for (const change of [{ kind: "TRANSFER" }, { confirmed: false }, { timezone: "America/New_York" }, { startsAt: "2027-01-01T09:00" }, { kind: "MONTHLY_REPORT", frequency: "DAILY" }, { endsAt: "2026-01-01T00:00:00Z" }]) {
      expect(scheduleInput.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it("requires a separate internal credential, never a bank session", () => {
    const original = process.env.SCHEDULER_TOKEN;
    try {
      delete process.env.SCHEDULER_TOKEN;
      expect(() => assertSchedulerRequest(new Request("http://localhost"))).toThrow("SCHEDULER_NOT_CONFIGURED");
      process.env.SCHEDULER_TOKEN = "x".repeat(40);
      expect(() => assertSchedulerRequest(new Request("http://localhost", { headers: { cookie: "bankpilot_session=anything" } }))).toThrow("INVALID_SCHEDULER_TOKEN");
      expect(() => assertSchedulerRequest(new Request("http://localhost", { headers: { authorization: `Bearer ${"x".repeat(40)}` } }))).not.toThrow();
    } finally { if (original === undefined) delete process.env.SCHEDULER_TOKEN; else process.env.SCHEDULER_TOKEN = original; }
  });
});
