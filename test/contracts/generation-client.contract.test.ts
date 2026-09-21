/**
 * One behavioural contract, run against every `GenerationClient` — the fake the scenario suite
 * leans on and the real Luma adapter (with `fetch` stubbed). Closes the Wave 1 carry-forward and
 * pins the invariants the use-cases depend on, so `FakeGenerationClient` can't drift from the real
 * adapter's shape (the Wave 2 audit caught exactly this: the fake used to make `completed` imply a
 * non-null `imageUrl`, which the real adapter does not guarantee).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LumaGenerationClient } from "../../src/adapters/luma-generation-client.js";
import type { Config } from "../../src/config.js";
import type { GenerationClient } from "../../src/ports/generation-client.js";
import { FakeGenerationClient } from "../fakes/fake-generation-client.js";

const KNOWN_STATES = ["queued", "processing", "completed", "failed"];

function runContract(name: string, make: () => GenerationClient): void {
  describe(`GenerationClient contract: ${name}`, () => {
    it("create() resolves an id and a known state", async () => {
      const handle = await make().create({
        prompt: "p",
        sourceImageUrl: "https://x/y.jpg",
        quality: "draft",
      });
      expect(handle.id).toBeTruthy();
      expect(KNOWN_STATES).toContain(handle.state);
    });

    it("get() never reports an imageUrl unless the state is completed", async () => {
      const client = make();
      const handle = await client.create({
        prompt: "p",
        sourceImageUrl: "https://x/y.jpg",
        quality: "draft",
      });
      const result = await client.get(handle.id);
      expect(KNOWN_STATES).toContain(result.state);
      if (result.state !== "completed") expect(result.imageUrl).toBeNull();
    });

    it("get() on an id create() never issued rejects", async () => {
      await expect(make().get("id-never-issued")).rejects.toThrow();
    });
  });
}

runContract("FakeGenerationClient", () => new FakeGenerationClient());

describe("GenerationClient contract: LumaGenerationClient (stubbed fetch)", () => {
  const config = {
    luma: { apiKey: "luma-api-test", baseUrl: "https://agents.lumalabs.ai/v1" },
  } as Config;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          return new Response(
            JSON.stringify({ id: "gen-contract", state: "queued" }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/id-never-issued")) {
          return new Response(JSON.stringify({ detail: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            id: "gen-contract",
            state: "processing",
            output: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  runContract("LumaGenerationClient", () => new LumaGenerationClient(config));
});
