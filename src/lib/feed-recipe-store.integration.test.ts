import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { deleteRecipe, getRecipePreview, listRecipes, previewRecipe, publishRecipes, saveRecipe } from "./feed-recipe-store";
import { listFeed, publishFeed } from "./feed-store";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("feed card recipes", () => {
  const customerId = randomUUID();
  const accountId = randomUUID();
  const visitors = [randomUUID(), randomUUID()];
  const recipe = {
    name: "咖啡周报", headline: "{period}咖啡花了 {total}",
    query: { direction: "out", merchantKeywords: ["咖啡"], period: "30d", groupBy: "merchant" },
    blocks: [{ type: "stat", value: "count" }, { type: "ranking", limit: 3 }],
    schedule: { every: "day", hour: 6 },
  };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Recipe test',$2)", [customerId, randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Test','CHECKING','TEST')", [accountId, customerId]);
    for (const id of visitors) await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [id, randomBytes(32).toString("hex")]);
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES
      ($1,'漫拿咖啡','餐饮',-3200,now() - interval '1 day'),($1,'星杯咖啡','餐饮',-2800,now() - interval '2 days'),($1,'老乡饭馆','餐饮',-4500,now() - interval '1 day')`, [accountId]);
  });
  afterAll(async () => {
    await query("DELETE FROM bank_transactions WHERE account_id=$1", [accountId]);
    await query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await query("DELETE FROM customers WHERE id=$1", [customerId]);
    await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [visitors]);
    await db.end();
  });

  it("previews without publishing, then saves for its creator only", async () => {
    const draft = await previewRecipe(customerId, visitors[0], recipe);
    expect(draft.post.title).toBe("近 30 天咖啡花了 ¥60");
    expect(draft.values).toMatchObject({ total: 6000, count: 2, top: "漫拿咖啡" });
    expect((await listFeed(customerId, visitors[0])).some(post => post.kind === "custom")).toBe(false);
    expect(await getRecipePreview(customerId, visitors[1], draft.id)).toBeNull();
    await expect(saveRecipe(customerId, visitors[1], draft.id)).rejects.toThrow("RECIPE_NOT_FOUND");

    expect(await saveRecipe(customerId, visitors[0], draft.id)).toMatchObject({ published: true, name: "咖啡周报" });
    expect((await getRecipePreview(customerId, visitors[0], draft.id))?.status).toBe("ACTIVE");
    const mine = (await listFeed(customerId, visitors[0])).filter(post => post.kind === "custom");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "近 30 天咖啡花了 ¥60", recipeId: draft.id });
    expect((await listFeed(customerId, visitors[1])).some(post => post.kind === "custom")).toBe(false);
    expect((await listFeed(customerId, null)).some(post => post.kind === "custom")).toBe(false);
    expect(await listRecipes(customerId, visitors[0])).toEqual([expect.objectContaining({ id: draft.id, name: "咖啡周报" })]);
    // 同一周期不会再发一条。
    expect(await publishRecipes(customerId, new Date())).toBe(0);
  });

  it("replaces a card when the user asks for a change, and deletes only one's own", async () => {
    const [old] = await listRecipes(customerId, visitors[0]);
    const changed = await previewRecipe(customerId, visitors[0], { ...recipe, name: "咖啡月报", schedule: { every: "month", day: 1, hour: 8 } });
    await saveRecipe(customerId, visitors[0], changed.id, old.id);
    expect((await listRecipes(customerId, visitors[0])).map(card => card.name)).toEqual(["咖啡月报"]);
    expect((await listFeed(customerId, visitors[0])).filter(post => post.kind === "custom").map(post => post.recipeId)).toEqual([changed.id]);
    expect(await deleteRecipe(customerId, visitors[1], changed.id)).toBe(false);
    expect(await deleteRecipe(customerId, visitors[0], changed.id)).toBe(true);
    expect((await listFeed(customerId, visitors[0])).some(post => post.kind === "custom")).toBe(false);
  });

  it("does not post the same system story twice when nothing changed", async () => {
    await publishFeed(customerId);
    const before = (await listFeed(customerId)).filter(post => post.kind === "money-flow");
    // 换一个周期的去重键：标题一样就不发。
    await query("UPDATE feed_posts SET dedupe_key=dedupe_key||':old' WHERE customer_id=$1 AND kind='money-flow'", [customerId]);
    await publishFeed(customerId);
    expect((await listFeed(customerId)).filter(post => post.kind === "money-flow")).toHaveLength(before.length);
  });
});
