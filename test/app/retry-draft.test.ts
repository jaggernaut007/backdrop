import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { toColorSet } from "../../src/domain/colorset.js";
import { retryDraft } from "../../src/app/retry-draft.js";
import type {
  Decision,
  GenerationAttempt,
  Product,
  ShotRequest,
} from "../../src/domain/types.js";
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
  DRAFT_COST_CENTS: "5",
};

describe("retryDraft", () => {
  let repo: InMemoryRepository;
  let gen: FakeGenerationClient;
  let clock: FakeClock;
  let config: Config;
  let slack: FakeSlackGateway;

  const product: Product = {
    sku: "HG-002",
    name: "Stoneware Mug",
    category: "Ceramics",
    colorRaw: "Sage",
    colorSet: toColorSet("Sage"),
    material: "Stoneware",
    priceCents: 2400,
    photoUrl: "https://catalog.test/assets/hg-002.jpg",
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
  };

  /** A Request the approver rejected once: `drafting` + `retryUsed`, no generation in flight. */
  const rejectedOnce = (over: Partial<ShotRequest> = {}): ShotRequest => ({
    id: "r1",
    sku: "HG-002",
    ideaRevision: 1,
    status: "drafting",
    shotIdeaText: "on a sunlit windowsill",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: true,
    createdAt: "2026-09-06T12:00:00.000Z",
    draftPostedAt: "2026-09-06T12:30:00.000Z",
    escalatedAt: null,
    ...over,
  });

  const rejectDecision = (
    reason: Decision["reason"],
    at = "2026-09-06T12:45:00.000Z",
  ): Decision => ({
    id: randomUUID(),
    requestId: "r1",
    attemptId: "a-draft-1",
    actor: "U_APPROVER",
    verb: "reject",
    reason,
    at,
  });

  const deps = () => ({ repo, clock, generationClient: gen, config, slack });

  beforeEach(() => {
    repo = new InMemoryRepository();
    gen = new FakeGenerationClient();
    clock = new FakeClock("2026-09-06T13:00:00.000Z");
    config = loadConfig(ENV);
    slack = new FakeSlackGateway();
    repo.upsertProduct(product);
  });

  it("throws for an unknown Request id", async () => {
    await expect(
      retryDraft(deps(), { requestId: "nope" }),
    ).rejects.toThrow(/no Request nope/);
  });

  it("throws when the Request is not awaiting a retry (wrong status)", async () => {
    repo.saveRequest(rejectedOnce({ status: "in_review" }));
    await expect(retryDraft(deps(), { requestId: "r1" })).rejects.toThrow(
      /not awaiting a retry/,
    );
  });

  it("throws when the Request is drafting but no retry was granted", async () => {
    repo.saveRequest(rejectedOnce({ retryUsed: false }));
    await expect(retryDraft(deps(), { requestId: "r1" })).rejects.toThrow(
      /no retry granted/,
    );
  });

  it("throws when a retry attempt already exists — one retry only", async () => {
    repo.saveRequest(rejectedOnce());
    const existing: GenerationAttempt = {
      id: "a-retry-1",
      requestId: "r1",
      kind: "retry",
      promptText: "…",
      inputPhotoUrl: product.photoUrl,
      lumaGenerationId: "gen_x",
      resultImageUrl: null,
      spendCents: 5,
      status: "pending",
      rejectReason: "color off",
      createdAt: "2026-09-06T12:50:00.000Z",
      completedAt: null,
    };
    repo.saveAttempt(existing);
    await expect(retryDraft(deps(), { requestId: "r1" })).rejects.toThrow(
      /already has a retry attempt/,
    );
    expect(gen.creates).toHaveLength(0);
  });

  it("carries the latest reject reason into the prompt and books a pending retry attempt", async () => {
    repo.saveRequest(rejectedOnce());
    repo.saveDecision(rejectDecision("wrong vibe", "2026-09-06T12:45:00.000Z"));
    // A later reject (e.g. across the lifecycle) — its `at` is strictly greater, so it wins.
    repo.saveDecision(rejectDecision("color off", "2026-09-06T12:50:00.000Z"));

    const res = await retryDraft(deps(), { requestId: "r1" });

    expect(res.retryReason).toBe("color off");
    expect(gen.creates).toHaveLength(1);
    expect(gen.creates[0]?.quality).toBe("draft");
    expect(gen.creates[0]?.sourceImageUrl).toBe(product.photoUrl);
    expect(gen.creates[0]?.prompt).toContain("color off");
    expect(gen.creates[0]?.prompt).toContain("second attempt");

    const retries = repo
      .listAttemptsForRequest("r1")
      .filter((a) => a.kind === "retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.status).toBe("pending");
    expect(retries[0]?.spendCents).toBe(5);
    expect(retries[0]?.rejectReason).toBe("color off");
    expect(retries[0]?.lumaGenerationId).toBe(res.lumaGenerationId);
    // The aggregate stays `drafting` — `resolvePendingGenerations` posts it for review later.
    expect(repo.getRequest("r1")?.status).toBe("drafting");
  });

  it("falls back to reason `other` when there is no reject Decision on record", async () => {
    repo.saveRequest(rejectedOnce());
    const res = await retryDraft(deps(), { requestId: "r1" });
    expect(res.retryReason).toBe("other");
    expect(gen.creates[0]?.prompt).toContain('rejected as "other"');
  });

  it("throws when the Product for the SKU is missing", async () => {
    repo.saveRequest(rejectedOnce({ sku: "HG-999" }));
    await expect(retryDraft(deps(), { requestId: "r1" })).rejects.toThrow(
      /no Product for SKU HG-999/,
    );
  });
});
