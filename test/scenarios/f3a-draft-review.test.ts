/**
 * F3a — Draft generation & review loop. Scenario names are SPEC.md verbatim.
 *
 * Slack + Luma + the image store are faked at the port boundary; the pipeline runs in-process:
 * `startConfirmedDrafts` (compose → generate) then `resolvePendingGenerations` (poll → re-host →
 * post) then `handleDecision` (the tap).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { toColorSet } from "../../src/domain/colorset.js";
import type { Product, ShotRequest } from "../../src/domain/types.js";
import { handleDecision } from "../../src/app/handle-decision.js";
import {
  resolvePendingGenerations,
  startConfirmedDrafts,
  type PipelineTickDeps,
} from "../../src/app/run-pipeline-tick.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeGenerationClient } from "../fakes/fake-generation-client.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryImageStore } from "../fakes/in-memory-image-store.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const ELLIE = "U_APPROVER";
const NOT_ELLIE = "U_WEBPERSON";

const TEST_ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C_TEST",
  APPROVER_SLACK_USER_ID: ELLIE,
  ESCALATION_SLACK_USER_ID: "U_ESCALATION",
  LUMA_AGENTS_API_KEY: "luma-api-test",
  DRAFT_COST_CENTS: "5",
  FINAL_COST_CENTS: "11",
  // SPEC F3a's binding-actor scenario ("a tap by anyone other than the approver is ignored") needs the
  // gate on. The open-approval default (anyone can tap) is covered in handle-decision.test.ts.
  OPEN_APPROVAL: "false",
};

describe("F3a — Draft generation & review loop", () => {
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
    sku: "HG-041",
    name: "Ribbed Tumbler Set (4)",
    category: "Glassware",
    colorRaw: "Smoke",
    colorSet: toColorSet("Smoke"),
    material: "Recycled glass",
    priceCents: 3800,
    photoUrl: "https://catalog.test/assets/hg-041.jpg",
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
    ...over,
  });

  const request = (over: Partial<ShotRequest> = {}): ShotRequest => ({
    id: "r1",
    sku: "HG-041",
    ideaRevision: 1,
    status: "confirmed",
    shotIdeaText: "on a set dinner table, with food in it?",
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

  /** Run a confirmed Request through to a Draft posted for review (`in_review`). */
  async function postDraft(): Promise<void> {
    await startConfirmedDrafts(deps());
    await resolvePendingGenerations(deps());
  }

  /**
   * F7 / ADR 0019: the Draft/Finals review card posts into a batch's thread, which needs an open
   * `CatalogImport` (+ its row + status post) to exist for the SKU — these tests drive `run-draft`/
   * `resolvePendingGenerations` directly rather than through `ingestCatalog`, so set up the minimal
   * batch scaffolding by hand.
   */
  function openBatch(sku = "HG-041"): void {
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
    // A sentinel ts well outside `FakeSlackGateway`'s own generated sequence (`1700000000.NNNNNN`)
    // so it's never coincidentally equal to a ts the fake mints during the test.
    repo.saveBatchStatusPost({
      importId,
      slackChannel: "C_TEST",
      slackTs: "9999999999.000001",
      completedAt: null,
      exportUploadedAt: null,
    });
  }

  beforeEach(() => {
    repo = new InMemoryRepository();
    gen = new FakeGenerationClient();
    slack = new FakeSlackGateway();
    store = new InMemoryImageStore();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
    config = loadConfig(TEST_ENV);
  });

  it("A confirmed Request produces one Draft posted for review", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(
      request({
        shotIdeaText: "on a set dinner table, with food in it?",
        riskFlags: ["smoke glass photographs badly, careful"],
      }),
    );

    await startConfirmedDrafts(deps());

    // GenerationPrompt composed from Shot Idea + ColorSet + the risk flag.
    expect(gen.creates).toHaveLength(1);
    const [call] = gen.creates;
    expect(call?.quality).toBe("draft");
    expect(call?.sourceImageUrl).toBe("https://catalog.test/assets/hg-041.jpg");
    expect(call?.prompt).toContain("on a set dinner table, with food in it?");
    expect(call?.prompt).toContain("Smoke");
    expect(call?.prompt).toContain("smoke glass photographs badly, careful");

    // Exactly one Draft attempt, pending, spend booked.
    const attempts = repo.listAttemptsForRequest("r1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.kind).toBe("draft");
    expect(attempts[0]?.status).toBe("pending");
    expect(attempts[0]?.spendCents).toBe(5);
    expect(repo.getRequest("r1")?.status).toBe("drafting");

    await resolvePendingGenerations(deps());

    // One image generated, re-hosted (not Luma's expiring URL), and posted with Approve/Reject.
    expect(gen.creates).toHaveLength(1);
    const drafts = slack.postsOfKind("draft-review");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.meta?.["requestId"]).toBe("r1");
    expect(drafts[0]?.meta?.["imageUrl"]).toContain("/img/");

    const resolved = repo.listAttemptsForRequest("r1")[0];
    expect(resolved?.status).toBe("succeeded");
    expect(resolved?.resultImageUrl).toContain("/img/");
    expect(store.stored[0]?.sourceUrl).toContain("fake-luma");
    expect(store.stored[0]?.filename.startsWith("hg-041-draft-")).toBe(true);

    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(repo.getLatestReviewPostForRequest("r1", "draft")).not.toBeNull();
  });

  it("the approver taps Approve and the direction is locked", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(request());
    await postDraft();

    const res = await handleDecision(
      { repo, clock, gateway: slack, config },
      { requestId: "r1", actor: ELLIE, verb: "approve" },
    );

    expect(res.applied).toBe(true);
    expect(repo.getRequest("r1")?.status).toBe("approved");

    const decisions = repo.listDecisionsForRequest("r1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.actor).toBe(ELLIE);
    expect(decisions[0]?.verb).toBe("approve");
  });

  it("A tap by anyone other than the approver is ignored", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(request());
    await postDraft();

    const res = await handleDecision(
      { repo, clock, gateway: slack, config },
      { requestId: "r1", actor: NOT_ELLIE, verb: "approve" },
    );

    expect(res.applied).toBe(false);
    expect(res.ignoredReason).toBe("not-binding-actor");
    // The Request does not change state and no Finals are generated.
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(repo.listDecisionsForRequest("r1")).toHaveLength(0);
    expect(
      repo.listAttemptsForRequest("r1").filter((a) => a.kind === "final"),
    ).toHaveLength(0);
  });

  it("the approver taps Reject with a reason and no Finals spend is recorded", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(request());
    await postDraft();
    const spendBeforeReject = repo.totalSpendCents();

    const res = await handleDecision(
      { repo, clock, gateway: slack, config },
      { requestId: "r1", actor: ELLIE, verb: "reject", reason: "too staged" },
    );

    expect(res.applied).toBe(true);
    const decisions = repo.listDecisionsForRequest("r1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.verb).toBe("reject");
    expect(decisions[0]?.reason).toBe("too staged");

    // No finals-spend entry is written for that Request.
    expect(
      repo.listAttemptsForRequest("r1").every((a) => a.kind !== "final"),
    ).toBe(true);
    expect(repo.totalSpendCents()).toBe(spendBeforeReject); // only the one Draft was ever billed
  });
});
