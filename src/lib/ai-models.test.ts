import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const baseURL = "https://models.example.test/v1";
const apiKey = "test-only-upstream-secret";
const defaultModel = "bank-default-model";
const fetchMock = vi.fn<typeof fetch>();
function response(data: unknown) { return Response.json({ data }); }

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AI_BASE_URL", `${baseURL}/`);
  vi.stubEnv("AI_API_KEY", apiKey);
  vi.stubEnv("AI_MODEL", defaultModel);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("AI model catalog boundary", () => {
  it("authenticates only to the configured upstream and exposes model IDs without upstream metadata", async () => {
    fetchMock.mockResolvedValue(response([
      { id: defaultModel, owned_by: "private-owner", api_key: apiKey, internal_url: "https://private.example" },
      { id: "provider/second-model", permission: [{ secret: "private-permission" }] },
    ]));
    const { getAIModels } = await import("./ai-models");
    const result = await getAIModels();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${baseURL}/models`, expect.objectContaining({
      headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store", signal: expect.any(AbortSignal),
    }));
    expect(result).toEqual({ models: [defaultModel, "provider/second-model"], defaultModel });
    expect(JSON.stringify(result)).not.toMatch(/private-owner|private-permission|private\.example|api_key|test-only-upstream-secret/);
  });

  it("deduplicates and sorts IDs while filtering malformed entries and unsafe characters", async () => {
    fetchMock.mockResolvedValue(response([
      { id: "z-model:latest+tools" }, { id: defaultModel }, { id: defaultModel }, { id: "provider/a_b.c-1" },
      null, "raw-id", 7, {}, { id: false }, { id: [] }, { id: "" }, { id: "x".repeat(161) },
      { id: "model with spaces" }, { id: "模型" }, { id: "<script>" }, { id: "model?key=value" },
      { id: "model\nAuthorization: injected" },
    ]));
    const { getAIModels } = await import("./ai-models");
    expect(await getAIModels()).toEqual({ models: [defaultModel, "provider/a_b.c-1", "z-model:latest+tools"], defaultModel });
  });

  it("bounds a large catalog and supplies a usable listed default when the configured default is absent", async () => {
    fetchMock.mockResolvedValue(response(Array.from({ length: 250 }, (_, index) => ({ id: `model-${String(index).padStart(3, "0")}` }))));
    const { getAIModels } = await import("./ai-models");
    const catalog = await getAIModels();
    expect(catalog.models).toHaveLength(200);
    expect(catalog.defaultModel).toBe("model-000");
    expect(catalog.models).toContain(catalog.defaultModel);
  });

  it("caches a successful catalog for one minute and refreshes after expiry", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    fetchMock.mockImplementation(async () => response([{ id: defaultModel }]));
    const { getAIModels } = await import("./ai-models");
    await getAIModels();
    clock.mockReturnValue(60999);
    await getAIModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(61000);
    await getAIModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one upstream request between simultaneous callers", async () => {
    let release!: (result: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
    const { getAIModels } = await import("./ai-models");
    const pending = Array.from({ length: 8 }, () => getAIModels());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(response([{ id: defaultModel }]));
    for (const catalog of await Promise.all(pending)) expect(catalog).toEqual({ models: [defaultModel], defaultModel });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["AI_API_KEY", "AI_BASE_URL", "AI_MODEL"] as const)("invalidates a cached catalog after %s changes", async variable => {
    fetchMock.mockImplementation(async () => response([{ id: "other-model" }, { id: defaultModel }]));
    const { getAIModels } = await import("./ai-models");
    await getAIModels();
    vi.stubEnv(variable, variable === "AI_BASE_URL" ? "https://new-models.example.test/v1" : "changed-test-value");
    await getAIModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (variable === "AI_API_KEY") expect(fetchMock.mock.calls[1][1]?.headers).toEqual({ Authorization: "Bearer changed-test-value" });
    if (variable === "AI_BASE_URL") expect(fetchMock.mock.calls[1][0]).toBe("https://new-models.example.test/v1/models");
  });

  it("does not share an in-flight catalog with a newly configured provider", async () => {
    let releaseFirst!: (result: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseFirst = resolve; }));
    fetchMock.mockResolvedValueOnce(response([{ id: "new-provider-model" }]));
    const { getAIModels } = await import("./ai-models");
    const oldProvider = getAIModels();
    vi.stubEnv("AI_API_KEY", "different-provider-key");
    const nextProvider = await getAIModels();
    expect(nextProvider).toEqual({ models: ["new-provider-model"], defaultModel: "new-provider-model" });
    releaseFirst(response([{ id: "old-provider-model" }]));
    expect(await oldProvider).toEqual({ models: ["old-provider-model"], defaultModel: "old-provider-model" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["http", "transport", "json", "shape", "empty"])("returns a generic failure for %s errors without exposing secrets", async kind => {
    const secret = `secret ${apiKey} https://private.example/credentials`;
    if (kind === "http") fetchMock.mockResolvedValue(new Response(secret, { status: 502 }));
    if (kind === "transport") fetchMock.mockRejectedValue(new Error(secret));
    if (kind === "json") fetchMock.mockResolvedValue(new Response(secret));
    if (kind === "shape") fetchMock.mockResolvedValue(Response.json({ error: secret }));
    if (kind === "empty") fetchMock.mockResolvedValue(response([{ id: "not an allowed id" }]));
    const { getAIModels } = await import("./ai-models");
    await expect(getAIModels()).rejects.toEqual(new Error("AI_MODEL_CATALOG_UNAVAILABLE"));
  });

  it("clears a failed in-flight request so another attempt can recover", async () => {
    fetchMock.mockRejectedValueOnce(new Error(apiKey));
    fetchMock.mockResolvedValueOnce(response([{ id: defaultModel }]));
    const { getAIModels } = await import("./ai-models");
    await expect(getAIModels()).rejects.toThrow("AI_MODEL_CATALOG_UNAVAILABLE");
    expect(await getAIModels()).toEqual({ models: [defaultModel], defaultModel });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["AI_BASE_URL", "AI_API_KEY", "AI_MODEL"] as const)("fails closed before making a request when %s is missing", async variable => {
    vi.stubEnv(variable, undefined);
    const { getAIModels, resolveAIModel } = await import("./ai-models");
    await expect(getAIModels()).rejects.toThrow("AI_NOT_CONFIGURED");
    await expect(resolveAIModel()).rejects.toThrow("AI_NOT_CONFIGURED");
    await expect(resolveAIModel("other-model")).rejects.toThrow("AI_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AI model resolution", () => {
  it("uses the operator-configured default without requiring the optional catalog endpoint", async () => {
    const { resolveAIModel } = await import("./ai-models");
    expect(await resolveAIModel()).toBe(defaultModel);
    expect(await resolveAIModel(defaultModel)).toBe(defaultModel);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a selected model returned by the current provider catalog", async () => {
    fetchMock.mockResolvedValue(response([{ id: defaultModel }, { id: "allowed-model" }]));
    const { resolveAIModel } = await import("./ai-models");
    expect(await resolveAIModel("allowed-model")).toBe("allowed-model");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown or injected model names instead of forwarding them upstream", async () => {
    fetchMock.mockResolvedValue(response([{ id: defaultModel }]));
    const { resolveAIModel } = await import("./ai-models");
    await expect(resolveAIModel("unknown-model")).rejects.toThrow("AI_MODEL_NOT_AVAILABLE");
    await expect(resolveAIModel("model\nAuthorization: injected")).rejects.toThrow("AI_MODEL_NOT_AVAILABLE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
