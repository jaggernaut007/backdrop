import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { toColorSet } from "../../src/domain/colorset.js";
import { runDraft } from "../../src/app/run-draft.js";
import type { Product, ShotRequest } from "../../src/domain/types.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeGenerationClient } from "../fakes/fake-generation-client.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C_TEST",
  APPROVER_SLACK_USER_ID: "U_APPROVER",
  ESCALATION_SLACK_USER_ID: "U_ESCALATION",
  LUMA_AGENTS_API_KEY: "luma-api-test",
};

describe("runDraft guard clauses", () => {
  let repo: InMemoryRepository;
  let gen: FakeGenerationClient;
  let clock: FakeClock;
  let config: Config;
  let slack: FakeSlackGateway;

  const request: ShotRequest = {
    id: "r1",
    sku: "HG-002",
    ideaRevision: 1,
    status: "confirmed",
    shotIdeaText: "a windowsill",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-09-06T12:00:00.000Z",
    draftPostedAt: null,
    escalatedAt: null,
  };

  beforeEach(() => {
    repo = new InMemoryRepository();
    gen = new FakeGenerationClient();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
    config = loadConfig(ENV);
    slack = new FakeSlackGateway();
  });

  it("throws for an unknown Request id", async () => {
    await expect(
      runDraft(
        { repo, clock, generationClient: gen, config, slack },
        { requestId: "nope" },
      ),
    ).rejects.toThrow(/no Request nope/);
  });

  it("throws when the Request's Product row is missing — no generation is kicked", async () => {
    repo.saveRequest(request);
    await expect(
      runDraft(
        { repo, clock, generationClient: gen, config, slack },
        { requestId: "r1" },
      ),
    ).rejects.toThrow(/no Product for SKU HG-002/);
    expect(gen.creates).toHaveLength(0);
  });

  const productRow: Product = {
    sku: "HG-002",
    name: "Stoneware Mug 12oz",
    category: "Ceramics",
    colorRaw: "Sage",
    colorSet: toColorSet("Sage"),
    material: "Stoneware",
    priceCents: 2800,
    photoUrl: "https://catalog.test/hg-002.jpg",
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
  };

  it("validates the transition before spending — a non-confirmed Request throws with no create call", async () => {
    repo.upsertProduct(productRow);
    repo.saveRequest({ ...request, status: "in_review" });
    await expect(
      runDraft(
        { repo, clock, generationClient: gen, config, slack },
        { requestId: "r1" },
      ),
    ).rejects.toThrow(/illegal transition/);
    expect(gen.creates).toHaveLength(0);
    expect(repo.listAttemptsForRequest("r1")).toHaveLength(0);
  });

  it("when the model call throws, no attempt is written and the Request stays confirmed", async () => {
    repo.upsertProduct(productRow);
    repo.saveRequest(request);
    gen.create = () => Promise.reject(new Error("luma 503"));

    await expect(
      runDraft(
        { repo, clock, generationClient: gen, config, slack },
        { requestId: "r1" },
      ),
    ).rejects.toThrow(/luma 503/);

    expect(repo.listAttemptsForRequest("r1")).toHaveLength(0);
    expect(repo.getRequest("r1")?.status).toBe("confirmed"); // ADR 0014: converge next tick
  });
});
