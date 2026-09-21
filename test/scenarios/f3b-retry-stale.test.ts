/**
 * F3b — Retry & stale escalation. Scenario names are SPEC.md verbatim.
 *
 * Slack + Luma + the image store are faked at the port boundary. The retry path runs in-process
 * through the pipeline tick (`startRetryDrafts` → `resolvePendingGenerations`); the escalation path
 * runs through the staleness sweep (`runStalenessCheck`), which the scheduler drives on its own
 * slow interval in production.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { toColorSet } from "../../src/domain/colorset.js";
import type {
  Product,
  RejectReason,
  ShotRequest,
} from "../../src/domain/types.js";
import { handleDecision } from "../../src/app/handle-decision.js";
import { runStalenessCheck } from "../../src/app/staleness-check.js";
import {
  resolvePendingGenerations,
  startConfirmedDrafts,
  startRetryDrafts,
  type PipelineTickDeps,
} from "../../src/app/run-pipeline-tick.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeGenerationClient } from "../fakes/fake-generation-client.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryImageStore } from "../fakes/in-memory-image-store.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const ELLIE = "U_APPROVER";
const MAYA = "U_ESCALATION";

const TEST_ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C_TEST",
  APPROVER_SLACK_USER_ID: ELLIE,
  ESCALATION_SLACK_USER_ID: MAYA,
  LUMA_AGENTS_API_KEY: "luma-api-test",
  DRAFT_COST_CENTS: "5",
  FINAL_COST_CENTS: "11",
  STALE_THRESHOLD_DAYS: "3",
};

describe("F3b — Retry & stale escalation", () => {
  let repo: InMemoryRepository;
  let gen: FakeGenerationClient;
  let slack: FakeSlackGateway;
  let store: InMemoryImageStore;
  let clock: FakeClock;
  let config: Config;

  const deps = (): PipelineTickDeps => ({
    repo,
    clock,
    generationClient: gen,
    imageStore: store,
    gateway: slack,
    config,
  });

  const product = (over: Partial<Product> = {}): Product => ({
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
    ...over,
  });

  const request = (over: Partial<ShotRequest> = {}): ShotRequest => ({
    id: "r1",
    sku: "HG-002",
    ideaRevision: 1,
    status: "confirmed",
    shotIdeaText: "on a sunlit windowsill",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-09-06T12:00:00.000Z",
    draftPostedAt: null,
    escalatedAt: null,
    ...over,
  });

  /** Minimal F7 batch scaffolding so review cards have a thread to post into. */
  function openBatch(sku = "HG-002"): void {
    const importId = `imp-${sku}`;
    repo.saveImport({
      id: importId,
      receivedAt: "2026-09-06T12:00:00.000Z",
      sourceRef: "F_TEST",
      contentHash: `hash-${sku}`,
      rowCount: 1,
      nWithIdea: 1,
      nBlank: 0,
      nDone: 0,
    });
    repo.saveCatalogImportRow(importId, sku);
    repo.saveBatchStatusPost({
      importId,
      slackChannel: "C_TEST",
      slackTs: "9999999999.000001",
      completedAt: null,
      exportUploadedAt: null,
    });
  }

  /** Confirmed → a first Draft posted for review (`in_review`). */
  async function postFirstDraft(): Promise<void> {
    await startConfirmedDrafts(deps());
    await resolvePendingGenerations(deps());
  }

  async function reject(reason: RejectReason): Promise<void> {
    await handleDecision(
      { repo, clock, gateway: slack, config },
      { requestId: "r1", actor: ELLIE, verb: "reject", reason },
    );
  }

  beforeEach(() => {
    repo = new InMemoryRepository();
    gen = new FakeGenerationClient();
    slack = new FakeSlackGateway();
    store = new InMemoryImageStore();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
    config = loadConfig(TEST_ENV);
  });

  it("A rejected Draft is retried exactly once, using the reason", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(request());
    await postFirstDraft();
    expect(repo.getRequest("r1")?.status).toBe("in_review");

    // Given a Draft was rejected with reason `color off`.
    await reject("color off");
    expect(repo.getRequest("r1")?.status).toBe("drafting");
    expect(repo.getRequest("r1")?.retryUsed).toBe(true);

    // When the pipeline retries the Request.
    const started = await startRetryDrafts(deps());
    expect(started).toBe(1);

    // Then exactly one new Draft is generated, carrying the reason forward.
    expect(gen.creates).toHaveLength(2);
    expect(gen.creates[1]?.quality).toBe("draft");
    expect(gen.creates[1]?.prompt).toContain("color off");
    expect(gen.creates[1]?.prompt).toContain("second attempt");
    expect(gen.creates[1]?.prompt).toContain("on a sunlit windowsill");

    const retries = repo
      .listAttemptsForRequest("r1")
      .filter((a) => a.kind === "retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.rejectReason).toBe("color off");

    // ...and it is posted for review.
    await resolvePendingGenerations(deps());
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(slack.postsOfKind("draft-review").length).toBeGreaterThanOrEqual(2);

    // Exactly once: a further retry sweep does nothing (the retry is spent).
    const again = await startRetryDrafts(deps());
    expect(again).toBe(0);
    expect(gen.creates).toHaveLength(2);
  });

  it("A second rejection parks the Request", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(request());
    await postFirstDraft();
    await reject("too staged");
    await startRetryDrafts(deps());
    await resolvePendingGenerations(deps());
    // Given a Request whose retry Draft has been posted for review.
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    const spendBefore = repo.totalSpendCents();

    // When the approver rejects it a second time.
    await reject("too staged");

    // Then the Request moves to `parked`...
    expect(repo.getRequest("r1")?.status).toBe("parked");

    // ...no further Draft is generated...
    const started = await startRetryDrafts(deps());
    expect(started).toBe(0);
    expect(gen.creates).toHaveLength(2);

    // ...and no finals-spend entry is written.
    expect(
      repo.listAttemptsForRequest("r1").every((a) => a.kind !== "final"),
    ).toBe(true);
    expect(repo.totalSpendCents()).toBe(spendBefore);
  });

  it("A Draft un-tapped for the stale threshold escalates to the escalation contact", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(request());
    await postFirstDraft();
    expect(repo.getRequest("r1")?.status).toBe("in_review");

    // Given a Draft was posted for review 3 days ago and the approver has not tapped it.
    clock.advanceDays(3);

    // When the staleness check runs.
    const res = await runStalenessCheck({ repo, clock, gateway: slack, config });

    // Then the Request is marked `stale` and a Slack message @-mentioning the escalation contact is posted.
    expect(res.escalated).toBe(1);
    expect(repo.getRequest("r1")?.status).toBe("stale");
    expect(repo.getRequest("r1")?.escalatedAt).toBe(clock.now());
    const mentions = slack.postsOfKind("mention-escalation");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.text).toContain(`<@${MAYA}>`);
    expect(mentions[0]?.text).toContain("HG-002");
  });

  it("A Draft still within the threshold does not escalate", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(request());
    await postFirstDraft();

    // Given a Draft was posted for review 2 days ago and the approver has not tapped it.
    clock.advanceDays(2);

    // When the staleness check runs.
    const res = await runStalenessCheck({ repo, clock, gateway: slack, config });

    // Then the Request is not marked `stale` and the escalation contact is not @-mentioned.
    expect(res.escalated).toBe(0);
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(slack.postsOfKind("mention-escalation")).toHaveLength(0);
  });
});
