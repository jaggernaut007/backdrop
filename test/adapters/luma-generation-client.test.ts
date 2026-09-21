/**
 * `LumaGenerationClient` against a stubbed `fetch` — request shape, response mapping, and the error
 * surface. Closes the Wave 1 carry-forward: the real adapter is checked to honour the same contract
 * `FakeGenerationClient` promises the use-cases (state strings, `imageUrl` null unless completed,
 * throw on a non-2xx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LumaGenerationClient } from "../../src/adapters/luma-generation-client.js";
import type { Config } from "../../src/config.js";

// Retry is off in this block — it covers request/response mapping and the single-shot error
// surface. Backoff behaviour has its own block below.
const config = {
  luma: {
    apiKey: "luma-api-test",
    baseUrl: "https://agents.lumalabs.ai/v1",
    maxRetries: 0,
    retryBaseMs: 1_000,
    retryMaxDelayMs: 30_000,
  },
} as Config;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("LumaGenerationClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("create: POSTs an image_edit with the source URL, bearer auth, and uni-1 for a draft", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "gen-abc", state: "queued" }, { status: 201 }),
    );

    const handle = await new LumaGenerationClient(config).create({
      prompt: "a windowsill at dawn",
      sourceImageUrl: "https://catalog.test/hg-002.jpg",
      quality: "draft",
    });

    expect(handle).toEqual({ id: "gen-abc", state: "queued" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agents.lumalabs.ai/v1/generations");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer luma-api-test",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      type: "image_edit",
      prompt: "a windowsill at dawn",
      source: { url: "https://catalog.test/hg-002.jpg" },
      model: "uni-1",
    });
  });

  it("create: uses uni-1-max for a final", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "gen-x", state: "queued" }, { status: 201 }),
    );
    await new LumaGenerationClient(config).create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "final",
    });
    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
        .model,
    ).toBe("uni-1-max");
  });

  it("get: maps a completed generation to output[0].url", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "gen-abc",
        state: "completed",
        output: [
          {
            type: "image",
            url: "https://storage.test/out.png?X-Amz-Expires=3600",
          },
        ],
      }),
    );
    const res = await new LumaGenerationClient(config).get("gen-abc");
    expect(res).toEqual({
      id: "gen-abc",
      state: "completed",
      imageUrl: "https://storage.test/out.png?X-Amz-Expires=3600",
      failureReason: null,
      failureCode: null,
    });
  });

  it("get: a processing generation carries no image URL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "g", state: "processing", output: [] }),
    );
    const res = await new LumaGenerationClient(config).get("g");
    expect(res.state).toBe("processing");
    expect(res.imageUrl).toBeNull();
  });

  it("get: a failed generation carries the failure_code and reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "g",
        state: "failed",
        output: [],
        failure_reason: "prompt was moderated",
        failure_code: "content_moderated",
      }),
    );
    const res = await new LumaGenerationClient(config).get("g");
    expect(res).toMatchObject({
      state: "failed",
      imageUrl: null,
      failureReason: "prompt was moderated",
      failureCode: "content_moderated",
    });
  });

  it("throws with the API detail and request id on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Missing or invalid API key" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-123",
        },
      }),
    );
    await expect(new LumaGenerationClient(config).get("g")).rejects.toThrow(
      /HTTP 401 — Missing or invalid API key .*req-123/,
    );
  });

  it("get: throws on an unrecognised state string rather than passing it through", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "g", state: "dreaming", output: [] }),
    );
    await expect(new LumaGenerationClient(config).get("g")).rejects.toThrow(
      /unrecognised generation state/,
    );
  });

  it("create: tolerates an unrecognised state (the generation exists and is paid for) — treats it as queued", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "gen-z", state: "provisioning" }, { status: 201 }),
    );
    const handle = await new LumaGenerationClient(config).create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "draft",
    });
    expect(handle).toEqual({ id: "gen-z", state: "queued" });
  });

  it("get: a completed generation with an empty output array maps to imageUrl null", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "g", state: "completed", output: [] }),
    );
    const res = await new LumaGenerationClient(config).get("g");
    expect(res).toMatchObject({ state: "completed", imageUrl: null });
  });

  it("surfaces a non-JSON error body as raw text, still carrying the HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(new LumaGenerationClient(config).get("g")).rejects.toThrow(
      /Luma get failed: HTTP 502 — .*502 Bad Gateway/,
    );
  });

  it("create: surfaces a non-2xx as a create-tagged error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "prompt too long" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      new LumaGenerationClient(config).create({
        prompt: "p",
        sourceImageUrl: "https://x/y.jpg",
        quality: "draft",
      }),
    ).rejects.toThrow(/Luma create failed: HTTP 400 — prompt too long/);
  });

  it("sends an abort signal on every call (no unbounded hang)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "g", state: "queued" }, { status: 201 }),
    );
    await new LumaGenerationClient(config).create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "draft",
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("trims a trailing slash on the configured base URL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "g", state: "queued" }, { status: 201 }),
    );
    await new LumaGenerationClient({
      luma: { apiKey: "k", baseUrl: "https://agents.lumalabs.ai/v1/" },
    } as Config).create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "draft",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://agents.lumalabs.ai/v1/generations",
    );
  });
});

describe("LumaGenerationClient — retry on transient errors (ADR 0016)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const slept: number[] = [];
  const onRetry = vi.fn();

  // Instant sleep (records the requested duration), no jitter — deterministic.
  const deps = {
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    random: () => 0,
    onRetry,
    now: () => 1_000_000,
  };

  const client = (over: Partial<Config["luma"]> = {}) =>
    new LumaGenerationClient(
      {
        luma: {
          apiKey: "k",
          baseUrl: "https://agents.lumalabs.ai/v1",
          maxRetries: 5,
          retryBaseMs: 1_000,
          retryMaxDelayMs: 30_000,
          ...over,
        },
      } as Config,
      deps,
    );

  const rateLimited = (headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify({ detail: "Rate limit exceeded" }), {
      status: 429,
      headers: { "content-type": "application/json", ...headers },
    });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    slept.length = 0;
    onRetry.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("get: retries a 429 then returns the eventual success", async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(
        jsonResponse({ id: "g", state: "processing", output: [] }),
      );

    const res = await client().get("g");

    expect(res.state).toBe("processing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      op: "get",
      attempt: 1,
      status: 429,
    });
    expect(slept).toEqual([1_000]); // base * 2^0, no jitter
  });

  it("create: retries a 503 then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("upstream unavailable", { status: 503 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "gen-1", state: "queued" }, { status: 201 }),
      );

    const handle = await client().create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "final",
    });

    expect(handle).toEqual({ id: "gen-1", state: "queued" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("create: does NOT retry a non-retryable 4xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "prompt too long" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      client().create({
        prompt: "p",
        sourceImageUrl: "https://x/y.jpg",
        quality: "draft",
      }),
    ).rejects.toThrow(/HTTP 400 — prompt too long/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("gives up after maxRetries and throws the tagged error", async () => {
    fetchMock.mockResolvedValue(rateLimited({ "x-request-id": "req-x" }));

    await expect(client({ maxRetries: 2 }).get("g")).rejects.toThrow(
      /Luma get failed: HTTP 429/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(slept).toEqual([1_000, 2_000]);
  });

  it("get: retries a thrown network error (idempotent poll)", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        jsonResponse({ id: "g", state: "completed", output: [] }),
      );

    const res = await client().get("g");
    expect(res.state).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      op: "get",
      status: null,
    });
  });

  it("create: does NOT retry a thrown network error (double-spend guard)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      client().create({
        prompt: "p",
        sourceImageUrl: "https://x/y.jpg",
        quality: "final",
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("honours a Retry-After header for the sleep duration", async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimited({ "retry-after": "8" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "g", state: "processing", output: [] }),
      );

    await client().get("g");
    expect(slept).toEqual([8_000]); // 8s from the header, not the 1s exponential
  });

  it("maxRetries: 0 disables retry — one shot, throw on a 429", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited());

    await expect(client({ maxRetries: 0 }).get("g")).rejects.toThrow(
      /HTTP 429/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });
});
