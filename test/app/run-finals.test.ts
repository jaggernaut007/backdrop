import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { toColorSet } from "../../src/domain/colorset.js";
import { IllegalTransition } from "../../src/domain/shot-request.js";
import type { Product, ShotRequest } from "../../src/domain/types.js";
import { runFinals } from "../../src/app/run-finals.js";
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
  FINAL_COST_CENTS: "11",
};

describe("runFinals", () => {
  let repo: InMemoryRepository;
  let gen: FakeGenerationClient;
  let clock: FakeClock;
  let config: Config;
  let slack: FakeSlackGateway;

  const deps = () => ({ repo, clock, generationClient: gen, config, slack });

  const product = (): Product => ({
    sku: "HG-002",
    name: "Stoneware Mug",
    category: "Ceramics",
    colorRaw: "Sage",
    colorSet: toColorSet("Sage"),
    material: "Stoneware",
    priceCents: 4800,
    photoUrl: "https://catalog.test/assets/hg-002.jpg",
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
  });

  const request = (over: Partial<ShotRequest> = {}): ShotRequest => ({
    id: "r1",
    sku: "HG-002",
    ideaRevision: 1,
    status: "approved",
    shotIdeaText: "on a sunlit windowsill",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-09-06T12:00:00.000Z",
    draftPostedAt: "2026-09-06T12:30:00.000Z",
    escalatedAt: null,
    ...over,
  });

  beforeEach(() => {
    repo = new InMemoryRepository();
    gen = new FakeGenerationClient();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
    config = loadConfig(ENV);
    slack = new FakeSlackGateway();
  });

  it("throws on an unknown Request id", async () => {
    await expect(runFinals(deps(), { requestId: "nope" })).rejects.toThrow(
      /no Request/,
    );
  });

  it("throws IllegalTransition for a Request that is not approved — and spends nothing", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request({ status: "in_review" }));

    await expect(runFinals(deps(), { requestId: "r1" })).rejects.toBeInstanceOf(
      IllegalTransition,
    );
    expect(gen.creates).toHaveLength(0);
    expect(repo.listAttemptsForRequest("r1")).toHaveLength(0);
    expect(repo.getRequest("r1")?.status).toBe("in_review");
  });

  it("throws if the Product is gone, after validating the transition but before any create", async () => {
    repo.saveRequest(request()); // no product row
    await expect(runFinals(deps(), { requestId: "r1" })).rejects.toThrow(
      /no Product/,
    );
    expect(gen.creates).toHaveLength(0);
    expect(repo.getRequest("r1")?.status).toBe("approved");
  });

  it("kicks finalsPerDirection generations at uni-1-max quality and moves the Request to finalizing", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());

    const res = await runFinals(deps(), { requestId: "r1" });

    expect(res.attemptIds).toHaveLength(config.pipeline.finalsPerDirection);
    expect(gen.creates).toHaveLength(config.pipeline.finalsPerDirection);
    expect(gen.creates.every((c) => c.quality === "final")).toBe(true);
    expect(
      gen.creates.every(
        (c) => c.sourceImageUrl === "https://catalog.test/assets/hg-002.jpg",
      ),
    ).toBe(true);

    const attempts = repo.listAttemptsForRequest("r1");
    expect(attempts).toHaveLength(config.pipeline.finalsPerDirection);
    expect(attempts.every((a) => a.kind === "final")).toBe(true);
    expect(attempts.every((a) => a.status === "pending")).toBe(true);
    expect(attempts.every((a) => a.spendCents === 11)).toBe(true);
    expect(repo.getRequest("r1")?.status).toBe("finalizing");
  });

  it("reuses the approved Draft attempt's prompt as the Finals direction", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());
    repo.saveAttempt({
      id: "draft-1",
      requestId: "r1",
      kind: "draft",
      promptText: "APPROVED DIRECTION PROMPT — sunlit windowsill, sage palette",
      inputPhotoUrl: "https://catalog.test/assets/hg-002.jpg",
      lumaGenerationId: "gen_draft_1",
      resultImageUrl: "https://pipeline.test/img/hg-002-draft-abcd1234.jpg",
      spendCents: 5,
      status: "succeeded",
      rejectReason: null,
      createdAt: "2026-09-06T12:10:00.000Z",
      completedAt: "2026-09-06T12:12:00.000Z",
    });
    repo.saveDecision({
      id: "dec-1",
      requestId: "r1",
      attemptId: "draft-1",
      actor: "U_APPROVER",
      verb: "approve",
      reason: null,
      at: "2026-09-06T12:15:00.000Z",
    });

    const res = await runFinals(deps(), { requestId: "r1" });

    expect(res.promptText).toBe(
      "APPROVED DIRECTION PROMPT — sunlit windowsill, sage palette",
    );
    expect(
      gen.creates.every(
        (c) =>
          c.prompt ===
          "APPROVED DIRECTION PROMPT — sunlit windowsill, sage palette",
      ),
    ).toBe(true);
  });

  it("falls back to the most recent succeeded attempt's prompt when there is no approve Decision", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());
    repo.saveAttempt({
      id: "retry-1",
      requestId: "r1",
      kind: "retry",
      promptText: "SECOND-ATTEMPT DIRECTION — less staged, morning light",
      inputPhotoUrl: "https://catalog.test/assets/hg-002.jpg",
      lumaGenerationId: "gen_retry_1",
      resultImageUrl: "https://pipeline.test/img/hg-002-draft-ef567890.jpg",
      spendCents: 5,
      status: "succeeded",
      rejectReason: null,
      createdAt: "2026-09-06T12:40:00.000Z",
      completedAt: "2026-09-06T12:42:00.000Z",
    });

    const res = await runFinals(deps(), { requestId: "r1" });

    expect(res.promptText).toBe(
      "SECOND-ATTEMPT DIRECTION — less staged, morning light",
    );
  });

  it("falls back to a freshly composed prompt when there is no prior attempt", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());

    const res = await runFinals(deps(), { requestId: "r1" });

    expect(res.promptText).toContain("on a sunlit windowsill");
    expect(res.promptText.length).toBeGreaterThan(0);
  });

  it("ignores an approve Decision whose attemptId is null and uses the most recent succeeded prompt", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());
    const succ = (id: string, at: string, prompt: string) => ({
      id,
      requestId: "r1",
      kind: "draft" as const,
      promptText: prompt,
      inputPhotoUrl: "https://catalog.test/assets/hg-002.jpg",
      lumaGenerationId: `g_${id}`,
      resultImageUrl: `https://pipeline.test/img/${id}.jpg`,
      spendCents: 5,
      status: "succeeded" as const,
      rejectReason: null,
      createdAt: at,
      completedAt: at,
    });
    repo.saveAttempt(
      succ("d1", "2026-09-06T12:05:00.000Z", "EARLIER DIRECTION"),
    );
    repo.saveAttempt(
      succ("d2", "2026-09-06T12:10:00.000Z", "LATEST DIRECTION"),
    );
    repo.saveDecision({
      id: "dec",
      requestId: "r1",
      attemptId: null,
      actor: "U_APPROVER",
      verb: "approve",
      reason: null,
      at: "2026-09-06T12:15:00.000Z",
    });

    const res = await runFinals(deps(), { requestId: "r1" });
    expect(res.promptText).toBe("LATEST DIRECTION"); // most recent wins
  });

  it("recomposes from the Product when the approved attempt row has an empty promptText", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());
    repo.saveAttempt({
      id: "d1",
      requestId: "r1",
      kind: "draft",
      promptText: "",
      inputPhotoUrl: "https://catalog.test/assets/hg-002.jpg",
      lumaGenerationId: "g1",
      resultImageUrl: "u",
      spendCents: 5,
      status: "succeeded",
      rejectReason: null,
      createdAt: "2026-09-06T12:05:00.000Z",
      completedAt: "2026-09-06T12:06:00.000Z",
    });
    repo.saveDecision({
      id: "dec",
      requestId: "r1",
      attemptId: "d1",
      actor: "U_APPROVER",
      verb: "approve",
      reason: null,
      at: "2026-09-06T12:15:00.000Z",
    });

    const res = await runFinals(deps(), { requestId: "r1" });
    expect(res.promptText).toContain("on a sunlit windowsill"); // fresh compose, not ""
  });

  // --- H1 / H2: interleaved writes + top-up --------------------------------

  it("writes each attempt row immediately, so a create failing mid fan-out still records the paid generations", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());

    let n = 0;
    const flakyGen = {
      async create() {
        n += 1;
        if (n === 2) throw new Error("luma 429 rate limited");
        return { id: `g${n}`, state: "queued" as const };
      },
      async get() {
        throw new Error("unused");
      },
    } as unknown as FakeGenerationClient;

    await expect(
      runFinals({ ...deps(), generationClient: flakyGen }, { requestId: "r1" }),
    ).rejects.toThrow("luma 429");

    // The 1 generation that DID succeed has a ledger row (DOMAIN.md: spend on every attempt).
    const attempts = repo.listAttemptsForRequest("r1");
    expect(attempts).toHaveLength(1);
    expect(
      attempts.every((a) => a.kind === "final" && a.status === "pending"),
    ).toBe(true);
    expect(repo.totalSpendCents()).toBe(11);
    // Not yet finalizing — the next tick tops up the shortfall.
    expect(repo.getRequest("r1")?.status).toBe("approved");
  });

  it("tops up only the shortfall on a re-run — never a second full batch (H2)", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());
    // Simulate a prior partial run: 1 final attempt already exists.
    repo.saveAttempt({
      id: "pre-1",
      requestId: "r1",
      kind: "final",
      promptText: "direction",
      inputPhotoUrl: "https://catalog.test/assets/hg-002.jpg",
      lumaGenerationId: "g_pre_1",
      resultImageUrl: null,
      spendCents: 11,
      status: "pending",
      rejectReason: null,
      createdAt: "2026-09-06T12:00:00.000Z",
      completedAt: null,
    });

    const res = await runFinals(deps(), { requestId: "r1" });

    expect(res.created).toBe(1); // only the shortfall
    expect(gen.creates).toHaveLength(1);
    expect(
      repo.listAttemptsForRequest("r1").filter((a) => a.kind === "final"),
    ).toHaveLength(2); // exactly the target, not 3
    expect(repo.getRequest("r1")?.status).toBe("finalizing");
  });

  it("a re-run over an already-complete batch creates nothing and just re-applies the transition", async () => {
    repo.upsertProduct(product());
    repo.saveRequest(request());
    await runFinals(deps(), { requestId: "r1" });
    repo.saveRequest(request()); // force back to approved as if saveRequest had been lost

    const res = await runFinals(deps(), { requestId: "r1" });

    expect(res.created).toBe(0);
    expect(gen.creates).toHaveLength(config.pipeline.finalsPerDirection); // unchanged
    expect(repo.getRequest("r1")?.status).toBe("finalizing");
  });
});
