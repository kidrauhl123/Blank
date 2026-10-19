import { describe, expect, it } from "vitest";
import { mergeTimelineEvents, type TimelineEvent } from "./timeline";

const event = (id: string, sequence: number, state: TimelineEvent["state"]): TimelineEvent =>
  ({ id, sequence, state, title: id, at: "2026-10-17T00:00:00Z" });

describe("task timeline events", () => {
  it("deduplicates reconnect events and retains the server sequence", () => {
    const merged = mergeTimelineEvents([event("second", 2, "running")],
      [event("first", 1, "done"), event("second", 2, "done")]);
    expect(merged.map((item) => [item.id, item.state])).toEqual([["first", "done"], ["second", "done"]]);
  });
});
