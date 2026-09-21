import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildHttpServer } from "../src/runtime/http.js";
import { FakeClock } from "./fakes/fake-clock.js";
import { FakeGenerationClient } from "./fakes/fake-generation-client.js";
import { InMemoryImageStore } from "./fakes/in-memory-image-store.js";
import { FakeSlackGateway } from "./fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "./fakes/in-memory-repository.js";

/**
 * Wave 0 smoke test — proves the scaffold wires together. Behavioural coverage of the individual
 * pieces lives in test/domain/, test/config.test.ts, test/runtime/, and test/fakes/*.test.ts.
 */
describe("scaffold", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "backdrop-"));

  it("HTTP server answers /healthz with 200", async () => {
    const app = await buildHttpServer({
      imagesDir: path.join(tmp, "images"),
      logger: false,
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("HTTP server reports 503 when isHealthy() is false", async () => {
    const app = await buildHttpServer({
      imagesDir: path.join(tmp, "images"),
      isHealthy: () => false,
      logger: false,
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("all five port fakes satisfy their interfaces", async () => {
    const repo = new InMemoryRepository();
    const slack = new FakeSlackGateway();
    const luma = new FakeGenerationClient();
    const store = new InMemoryImageStore();
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");

    expect(repo.totalSpendCents()).toBe(0);
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");

    const posted = await slack.postImportSummary("40 products received");
    expect(posted.ts).toMatch(/^1700000000\./);

    const handle = await luma.create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "draft",
    });
    expect((await luma.get(handle.id)).state).toBe("completed");

    const url = await store.putFromUrl(
      "hg-001-styled-01.jpg",
      "https://fake-luma.test/out/x.png",
    );
    expect(url).toBe("https://pipeline.test/img/hg-001-styled-01.jpg");
  });
});
