import { describe, expect, it } from "vitest";

import { FakeGenerationClient } from "./fake-generation-client.js";

const input = {
  prompt: "p",
  sourceImageUrl: "https://x/y.jpg",
  quality: "draft" as const,
};

describe("FakeGenerationClient", () => {
  it("auto-completes and records prompt + quality per create()", async () => {
    const luma = new FakeGenerationClient();
    const h = await luma.create(input);
    expect(h.state).toBe("queued");
    const r = await luma.get(h.id);
    expect(r.state).toBe("completed");
    expect(r.imageUrl).toMatch(/^https:\/\/fake-luma\.test\/out\/gen_1\.png/);
    expect(luma.creates[0]).toMatchObject({ prompt: "p", quality: "draft" });
  });

  it("throws on get() for an id it never issued (real Luma 404s)", async () => {
    const luma = new FakeGenerationClient();
    await expect(luma.get("gen_does_not_exist")).rejects.toThrow(
      /unknown generation id/,
    );
  });

  it("failGeneration(id) drives one failed poll with a machine code", async () => {
    const luma = new FakeGenerationClient();
    const h = await luma.create(input);
    luma.failGeneration(h.id);
    const r = await luma.get(h.id);
    expect(r).toMatchObject({
      state: "failed",
      imageUrl: null,
      failureCode: "generation_failed",
    });
  });

  it("failEverything() fails every subsequent poll", async () => {
    const luma = new FakeGenerationClient();
    luma.failEverything();
    const h = await luma.create(input);
    expect((await luma.get(h.id)).state).toBe("failed");
  });

  it("enableManualCompletion() holds at processing until markComplete(id)", async () => {
    const luma = new FakeGenerationClient();
    luma.enableManualCompletion();
    const h = await luma.create(input);
    expect(h.state).toBe("processing");
    expect((await luma.get(h.id)).state).toBe("processing");
    luma.markComplete(h.id);
    expect((await luma.get(h.id)).state).toBe("completed");
  });
});
