import { describe, expect, it } from "vitest";
import type { FeedPost } from "@/lib/feed";
import { DEFAULT_LAYOUT } from "@/lib/ui-schema";
import { arrange } from "./FeedPanel";

const post = (id: string, kind: FeedPost["kind"], recipeId?: string): FeedPost => ({ id, kind, title: id, body: "", source: "", attention: false, chart: { type: "recipe", blocks: [] }, factIds: [], publishedAt: "2026-10-29T00:00:00Z", ...(recipeId ? { recipeId } : {}) });
const posts = [post("a1", "anomaly"), post("p2", "position"), post("p1", "position"), post("c1", "custom", "coffee"), post("c2", "custom", "other"), post("f1", "friends")];
const ids = (sections: Parameters<typeof arrange>[1]) => arrange(posts, sections).map(group => group.posts.map(item => item.id));

describe("home layout arrangement", () => {
  it("the default layout shows every post once, in order", () => {
    expect(ids(DEFAULT_LAYOUT.home)).toEqual([[], ["a1", "p2", "p1", "c1", "c2", "f1"]]);
  });
  it("keeps only what the sections ask for, so the rest is hidden", () => {
    expect(ids([{ type: "feed", kinds: ["position"], limit: 1, latestPerKind: false }, { type: "feed", recipeIds: ["coffee"], limit: 5, latestPerKind: false }, { type: "assets" }])).toEqual([["p2"], ["c1"], []]);
  });
  it("gives a post to the first section that matches, honours latestPerKind and excludeKinds", () => {
    expect(ids([{ type: "feed", kinds: ["position", "custom"], limit: 9, latestPerKind: true }, { type: "feed", limit: 9, latestPerKind: false, excludeKinds: ["friends"] }]))
      .toEqual([["p2", "c1", "c2"], ["a1", "p1"]]);
  });
});
