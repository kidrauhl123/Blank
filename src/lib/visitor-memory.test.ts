import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), query: vi.fn() }));
vi.mock("./app-session", () => ({ requireAppSession: mocks.session }));
vi.mock("./db", () => ({ query: mocks.query }));

import { ensureVisitorMemoryToken, requireVisitorMemoryScope, VISITOR_MEMORY_COOKIE, visitorMemoryCookieOptions } from "./visitor-memory";

const tokenA = Buffer.alloc(32, 1).toString("base64url");
const tokenB = Buffer.alloc(32, 2).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const request = (token?: string) => new Request("https://bank.example/api/memory", {
  headers: token ? { cookie: `${VISITOR_MEMORY_COOKIE}=${token}` } : {},
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ customerId: "demo-customer" });
});

describe("visitor memory ownership", () => {
  it("reuses only a server-enrolled token and stores its hash", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "owner-a" }] }) } as unknown as PoolClient;
    expect(await ensureVisitorMemoryToken(tokenA, client)).toBe(tokenA);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("WHERE token_hash=$1"), [hash(tokenA)]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(visitorMemoryCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 90 * 86400 });
  });

  it("rotates an unknown browser-provided token instead of enrolling it", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rowCount: 1 }) } as unknown as PoolClient;
    const issued = await ensureVisitorMemoryToken(tokenA, client);
    expect(issued).not.toBe(tokenA);
    expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining("INSERT INTO visitor_memory_owners"), [hash(issued)]);
    expect(JSON.stringify((client.query as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(issued);
  });

  it("creates a new owner for a browser without the cookie", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) } as unknown as PoolClient;
    const issued = await ensureVisitorMemoryToken(undefined, client);
    expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("binds the same demo customer to distinct visitor owners", async () => {
    mocks.query.mockImplementation((_sql: string, values: string[]) => Promise.resolve({ rows: [{ owner_id: values[0] === hash(tokenA) ? "owner-a" : "owner-b", profile_key: "potato" }] }));
    expect(await requireVisitorMemoryScope(request(tokenA))).toEqual({ ownerId: "owner-a", profileKey: "potato" });
    expect(await requireVisitorMemoryScope(request(tokenB))).toEqual({ ownerId: "owner-b", profileKey: "potato" });
    expect(mocks.query.mock.calls.map((call) => call[1])).toEqual([[hash(tokenA), "demo-customer"], [hash(tokenB), "demo-customer"]]);
  });

  it("gets the profile from the authenticated session and refuses missing or unknown owners", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ owner_id: "owner-a", profile_key: "potato" }] });
    expect(await requireVisitorMemoryScope(request(tokenA))).toEqual({ ownerId: "owner-a", profileKey: "potato" });
    mocks.session.mockResolvedValueOnce({ customerId: "other-demo-customer" });
    mocks.query.mockResolvedValueOnce({ rows: [{ owner_id: "owner-a", profile_key: "chestnut" }] });
    expect(await requireVisitorMemoryScope(request(tokenA))).toEqual({ ownerId: "owner-a", profileKey: "chestnut" });
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(requireVisitorMemoryScope(request(tokenA))).rejects.toThrow("MEMORY_VISITOR_REQUIRED");
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([hash(tokenA), "demo-customer"]);
    await expect(requireVisitorMemoryScope(request())).rejects.toThrow("MEMORY_VISITOR_REQUIRED");
  });

  it("authenticates before looking up memory and rejects malformed values", async () => {
    mocks.session.mockRejectedValueOnce(new Error("AUTHENTICATION_REQUIRED"));
    await expect(requireVisitorMemoryScope(request(tokenA))).rejects.toThrow("AUTHENTICATION_REQUIRED");
    expect(mocks.query).not.toHaveBeenCalled();
    await expect(requireVisitorMemoryScope(request("forged"))).rejects.toThrow("MEMORY_VISITOR_REQUIRED");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
