import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { toColorSet } from "../../src/domain/colorset.js";
import type { Product, ShotRequest } from "../../src/domain/types.js";
import {
  publishReadyFinals,
  resolvePendingGenerations,
  runPipelineTick,
  startApprovedFinals,
  startConfirmedDrafts,
  startRetryDrafts,
  type PipelineTickDeps,
} from "../../src/app/run-pipeline-tick.js";
import {
  MAX_CONSECUTIVE_SLACK_FAILURES,
  SlackFailureTracker,
} from "../../src/app/slack-failure-tracker.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeGenerationClient } from "../fakes/fake-generation-client.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryImageStore } from "../fakes/in-memory-image-store.js";
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

describe("run-pipeline-tick", () => {
  let repo: InMemoryRepository;
  let gen: FakeGenerationClient;
  let slack: FakeSlackGateway;
  let store: InMemoryImageStore;
  let clock: FakeClock;
  let config: Config;
  let slackFailureTracker: SlackFailureTracker;

  const deps = (): PipelineTickDeps => ({
    repo,
    clock,
    generationClient: gen,
    imageStore: store,
    gateway: slack,
    config,
    slackFailureTracker,
  });

  const product = (sku: string): Product => ({
    sku,
    name: `Product ${sku}`,
    category: "Ceramics",
    colorRaw: "Sage",
    colorSet: toColorSet("Sage"),
    material: "Stoneware",
    priceCents: 2000,
    photoUrl: `https://catalog.test/${sku.toLowerCase()}.jpg`,
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
  });

  const request = (
    id: string,
    sku: string,
    over: Partial<ShotRequest> = {},
  ): ShotRequest => ({
    id,
    sku,
    ideaRevision: 1,
    status: "confirmed",
    shotIdeaText: `idea for ${sku}`,
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

  /**
   * F7 / ADR 0019: the Draft/Finals review card posts into a batch's thread, which needs an open
   * `CatalogImport` (+ row + status post) for the SKU — these tests drive the tick functions
   * directly rather than through `ingestCatalog`, so set up the minimal batch scaffolding by hand.
   * Idempotent per SKU (safe to call more than once, e.g. inside a loop over several SKUs).
   */
  function openBatch(sku: string): void {
    const importId = `imp-${sku}`;
    if (repo.getBatchStatusPost(importId)) return;
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
    // A sentinel ts well outside `FakeSlackGateway`'s own generated sequence.
    repo.saveBatchStatusPost({
      importId,
      slackChannel: "C_TEST",
      slackTs: `9999999999.${sku}`,
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
    config = loadConfig(ENV);
    slackFailureTracker = new SlackFailureTracker();
  });

  it("drafts confirmed Requests in queue order — a priority Note goes first", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.upsertProduct(product("HG-101"));
    openBatch("HG-101");
    repo.saveRequest(request("r-plain", "HG-100", { priorityRank: 0 }));
    repo.saveRequest(request("r-boss", "HG-101", { priorityRank: 100 }));

    const started = await startConfirmedDrafts(deps());

    expect(started).toBe(2);
    expect(gen.creates.map((c) => c.prompt.includes("HG-101"))).toEqual([
      true,
      false,
    ]);
  });

  it("only touches confirmed Requests — drafting / in_review are left alone", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100", { status: "drafting" }));
    const started = await startConfirmedDrafts(deps());
    expect(started).toBe(0);
    expect(gen.creates).toHaveLength(0);
  });

  it("holds a Request in drafting while its generation is still processing", async () => {
    gen.enableManualCompletion();
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));

    await runPipelineTick(deps());
    expect(repo.getRequest("r1")?.status).toBe("drafting");
    expect(slack.postsOfKind("draft-review")).toHaveLength(0);

    const genId = gen.creates[0]?.generationId ?? "";
    gen.markComplete(genId);
    await resolvePendingGenerations(deps());
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(slack.postsOfKind("draft-review")).toHaveLength(1);
  });

  it("a failed generation fails the Request, keeps the spend row, and says so in the channel", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));
    gen.failEverything();

    await runPipelineTick(deps());

    const attempt = repo.listAttemptsForRequest("r1")[0];
    expect(attempt?.status).toBe("failed");
    expect(attempt?.spendCents).toBe(5); // spend recorded even on failure (DOMAIN.md)
    expect(repo.getRequest("r1")?.status).toBe("failed");
    const msg = slack.postsOfKind("message").at(-1)?.text ?? "";
    expect(msg).toContain("Draft generation failed");
    expect(slack.postsOfKind("draft-review")).toHaveLength(0);
  });

  it("re-hosts the Luma image instead of passing its expiring URL to Slack", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));

    await runPipelineTick(deps());

    const posted = slack.postsOfKind("draft-review")[0];
    expect(posted?.meta?.["imageUrl"]).toContain("pipeline.test/img/");
    expect(posted?.meta?.["imageUrl"]).not.toContain("fake-luma");
    expect(store.stored[0]?.sourceUrl).toContain("fake-luma");
  });

  it("runPipelineTick is a no-op on an empty system", async () => {
    await expect(runPipelineTick(deps())).resolves.toBeUndefined();
    expect(gen.creates).toHaveLength(0);
    expect(slack.posts).toHaveLength(0);
  });

  it("a completed generation that returns no image is treated as a failure", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));
    await startConfirmedDrafts(deps());
    gen.completeWithoutImage(gen.creates[0]?.generationId ?? "");

    await resolvePendingGenerations(deps());

    const attempt = repo.listAttemptsForRequest("r1")[0];
    expect(attempt?.status).toBe("failed");
    expect(attempt?.spendCents).toBe(5); // spend still booked (DOMAIN.md)
    expect(repo.getRequest("r1")?.status).toBe("failed");
    expect(slack.postsOfKind("message").at(-1)?.text ?? "").toContain(
      "no image returned",
    );
    expect(slack.postsOfKind("draft-review")).toHaveLength(0);
  });

  it("running the tick repeatedly over one confirmed Request posts one draft and spends once", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));

    await runPipelineTick(deps());
    await runPipelineTick(deps());
    await runPipelineTick(deps());

    expect(slack.postsOfKind("draft-review")).toHaveLength(1);
    expect(repo.listAttemptsForRequest("r1")).toHaveLength(1);
    expect(repo.totalSpendCents()).toBe(5);
    expect(repo.getRequest("r1")?.status).toBe("in_review");
  });

  it("a pending attempt whose Request already left drafting is settled but not re-posted", async () => {
    gen.enableManualCompletion();
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));
    await startConfirmedDrafts(deps());
    const genId = gen.creates[0]?.generationId ?? "";
    repo.saveRequest(request("r1", "HG-100", { status: "parked" })); // moved behind the resolver's back
    gen.markComplete(genId);

    await resolvePendingGenerations(deps());

    expect(repo.listAttemptsForRequest("r1")[0]?.status).toBe("succeeded"); // stops being polled
    expect(slack.postsOfKind("draft-review")).toHaveLength(0); // guard held
    expect(repo.getRequest("r1")?.status).toBe("parked"); // not re-transitioned
  });

  it("resolves a final-kind attempt by re-hosting it, without posting — publishReadyFinals owns the message", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100", { status: "finalizing" }));
    const handle = await gen.create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "final",
    });
    repo.saveAttempt({
      id: "af1",
      requestId: "r1",
      kind: "final",
      promptText: "p",
      inputPhotoUrl: "https://catalog.test/hg-100.jpg",
      lumaGenerationId: handle.id,
      resultImageUrl: null,
      spendCents: 11,
      status: "pending",
      rejectReason: null,
      createdAt: "2026-09-06T12:00:00.000Z",
      completedAt: null,
    });

    await resolvePendingGenerations(deps());

    const resolved = repo.getAttempt("af1");
    expect(resolved?.status).toBe("succeeded");
    expect(resolved?.resultImageUrl).toContain("/img/");
    expect(store.stored[0]?.sourceUrl).toContain("fake-luma");
    // resolvePendingGenerations does not move the Request or post — that is publishReadyFinals.
    expect(repo.getRequest("r1")?.status).toBe("finalizing");
    expect(slack.posts).toHaveLength(0);
  });

  it("caps the number of Drafts kicked per tick (Luma concurrent-jobs ceiling)", async () => {
    for (let i = 0; i < 11; i += 1) {
      const sku = `HG-2${String(i).padStart(2, "0")}`;
      repo.upsertProduct(product(sku));
      openBatch(sku);
      repo.saveRequest(request(`r${i}`, sku));
    }
    const started = await startConfirmedDrafts(deps());
    expect(started).toBe(config.pipeline.maxDraftsPerTick);
    expect(gen.creates).toHaveLength(config.pipeline.maxDraftsPerTick);
    // the rest are still confirmed, picked up on the next tick
    expect(repo.listRequestsByStatus("confirmed")).toHaveLength(
      11 - config.pipeline.maxDraftsPerTick,
    );
  });

  it("uses console.error as the default item-error sink when no onItemError is given", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repo.saveRequest(request("r-bad", "HG-404")); // no Product row -> runDraft throws
    await startConfirmedDrafts(deps()); // deps() has no onItemError
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("one Request with a missing Product does not block the rest of the queue", async () => {
    const errs: string[] = [];
    const d = { ...deps(), onItemError: (c: string) => errs.push(c) };
    repo.upsertProduct(product("HG-101"));
    openBatch("HG-101");
    repo.saveRequest(request("r-bad", "HG-404", { priorityRank: 100 })); // no product row
    repo.saveRequest(request("r-good", "HG-101", { priorityRank: 0 }));

    const started = await startConfirmedDrafts(d);

    expect(started).toBe(1);
    expect(repo.getRequest("r-good")?.status).toBe("drafting");
    expect(repo.getRequest("r-bad")?.status).toBe("confirmed"); // retried next tick, not aborted
    expect(errs[0]).toContain("r-bad");
  });

  it("a paid-for Draft is not stranded when the Slack post fails — the next tick re-posts", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));

    await startConfirmedDrafts(deps()); // attempt created, Request -> drafting

    slack.failNext("draft-review");
    await resolvePendingGenerations({
      ...deps(),
      onItemError: () => undefined,
    });

    // Post threw; nothing past the attempt row committed — attempt is still pollable.
    expect(repo.listAttemptsForRequest("r1")[0]?.status).toBe("pending");
    expect(repo.getRequest("r1")?.status).toBe("drafting");
    expect(repo.getLatestReviewPostForRequest("r1", "draft")).toBeNull();

    await resolvePendingGenerations(deps()); // Slack healthy now

    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(repo.listAttemptsForRequest("r1")[0]?.status).toBe("succeeded");
    expect(slack.postsOfKind("draft-review")).toHaveLength(1);
    expect(repo.totalSpendCents()).toBe(5); // one draft, billed once
  });

  it("gives up on a Draft (not an endless retry) after repeated Slack post failures", async () => {
    // Mirrors the Finals general backstop: a Draft post that fails tick after tick — for whatever
    // reason — must not retry forever (slack-failure-tracker.ts), or it becomes the same
    // rate-limit-pressure incident that hit Finals for the deleted-image-files bug, just on the
    // Draft path instead.
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));
    await startConfirmedDrafts(deps());

    for (let i = 0; i < MAX_CONSECUTIVE_SLACK_FAILURES; i++) {
      slack.failNext("draft-review");
      await resolvePendingGenerations({
        ...deps(),
        onItemError: () => undefined,
      });
    }

    expect(repo.getRequest("r1")?.status).toBe("failed");
    expect(repo.listAttemptsForRequest("r1")[0]?.status).toBe("failed");
    expect(slack.postsOfKind("draft-review")).toHaveLength(0);
    expect(slack.postsOfKind("message").at(-1)?.text ?? "").toContain(
      "repeated Slack failures",
    );

    // The attempt has settled — a later sweep does nothing more.
    await resolvePendingGenerations(deps());
    expect(slack.postsOfKind("draft-review")).toHaveLength(0);
  });

  it("fails a Draft on the FIRST tick when Slack can't fetch the image (no 5-tick burn)", async () => {
    // Mirrors the Finals `isUnrenderableImagesError` fast-path: a post Slack can never render is
    // permanent, so don't spend MAX_CONSECUTIVE_SLACK_FAILURES ticks — each re-fetching the image —
    // discovering that.
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.saveRequest(request("r1", "HG-100"));
    await startConfirmedDrafts(deps());

    slack.failNextWith("draft-review", {
      code: "slack_webapi_platform_error",
      data: {
        error: "invalid_blocks",
        errors: ["downloading image failed [json-pointer:/blocks/1/image_url]"],
      },
    });
    await resolvePendingGenerations({ ...deps(), onItemError: () => undefined });

    expect(repo.getRequest("r1")?.status).toBe("failed");
    expect(repo.listAttemptsForRequest("r1")[0]?.status).toBe("failed");
    expect(slack.postsOfKind("draft-review")).toHaveLength(0);
    expect(slack.postsOfKind("message").at(-1)?.text ?? "").toContain(
      "could not be loaded for review",
    );

    // Settled — a later sweep does nothing more.
    await resolvePendingGenerations(deps());
    expect(slack.postsOfKind("draft-review")).toHaveLength(0);
  });

  // --- Wave 3: Finals (auto-publish, ADR 0020) ---------------------------------

  it("startApprovedFinals kicks finalsPerDirection Finals for an approved Request and moves it to finalizing", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));

    const started = await startApprovedFinals(deps());

    expect(started).toBe(1);
    const finals = repo
      .listAttemptsForRequest("r1")
      .filter((a) => a.kind === "final");
    expect(finals).toHaveLength(config.pipeline.finalsPerDirection);
    expect(finals.every((a) => a.status === "pending")).toBe(true);
    expect(gen.creates.every((c) => c.quality === "final")).toBe(true);
    expect(repo.getRequest("r1")?.status).toBe("finalizing");
  });

  it("startApprovedFinals never touches a Request that is not approved", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "in_review" }));
    repo.saveRequest(request("r2", "HG-002", { status: "parked" }));

    const started = await startApprovedFinals(deps());

    expect(started).toBe(0);
    expect(gen.creates).toHaveLength(0);
    expect(repo.totalSpendCents()).toBe(0);
  });

  it("caps the number of Requests moved into Finals per tick", async () => {
    for (let i = 0; i < 3; i += 1) {
      const sku = `HG-3${String(i).padStart(2, "0")}`;
      repo.upsertProduct(product(sku));
      openBatch(sku);
      repo.saveRequest(request(`r${i}`, sku, { status: "approved" }));
    }
    const started = await startApprovedFinals(deps());
    expect(started).toBe(config.pipeline.maxFinalsStartsPerTick);
    expect(repo.listRequestsByStatus("approved")).toHaveLength(
      3 - config.pipeline.maxFinalsStartsPerTick,
    );
  });

  it("a priority Request wins the Finals slot over an older un-prioritised one", async () => {
    repo.upsertProduct(product("HG-100"));
    openBatch("HG-100");
    repo.upsertProduct(product("HG-101"));
    openBatch("HG-101");
    repo.saveRequest(
      request("r-plain", "HG-100", {
        status: "approved",
        priorityRank: 0,
        createdAt: "2026-09-06T12:00:00.000Z",
      }),
    );
    repo.saveRequest(
      request("r-boss", "HG-101", {
        status: "approved",
        priorityRank: 100,
        createdAt: "2026-09-06T12:30:00.000Z",
      }),
    );

    await startApprovedFinals(deps());

    // One Finals start per tick (config); the priority SKU gets it first.
    expect(repo.getRequest("r-boss")?.status).toBe("finalizing");
    expect(repo.getRequest("r-plain")?.status).toBe("approved");
  });

  it("one approved Request with a missing Product does not block the rest", async () => {
    const errs: string[] = [];
    const d = { ...deps(), onItemError: (c: string) => errs.push(c) };
    repo.saveRequest(request("r-bad", "HG-404", { status: "approved" })); // no product row
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r-good", "HG-002", { status: "approved" }));

    await startApprovedFinals(d);

    expect(repo.getRequest("r-good")?.status).toBe("finalizing");
    expect(repo.getRequest("r-bad")?.status).toBe("approved"); // retried next tick, not aborted
    expect(errs.some((e) => e.includes("r-bad"))).toBe(true);
  });

  it("publishReadyFinals auto-publishes every completed Final and moves the Request to done", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));
    gen.enableManualCompletion();
    await startApprovedFinals(deps());
    const genIds = gen.creates.map((c) => c.generationId);

    // Only one of two done — nothing publishes yet.
    gen.markComplete(genIds[0] ?? "");
    await resolvePendingGenerations(deps());
    await publishReadyFinals(deps());
    expect(slack.postsOfKind("finals-published")).toHaveLength(0);
    expect(repo.getRequest("r1")?.status).toBe("finalizing");

    // Second completes — both published, Request → done, one hyperlinked message.
    gen.markComplete(genIds[1] ?? "");
    await resolvePendingGenerations(deps());
    await publishReadyFinals(deps());

    const posts = slack.postsOfKind("finals-published");
    expect(posts).toHaveLength(1);
    expect((posts[0]?.meta?.["published"] as unknown[]).length).toBe(2);
    expect(posts[0]?.meta?.["status"]).toBe("done");
    expect(repo.getRequest("r1")?.status).toBe("done");
    expect(repo.listPublishedForRequest("r1").map((p) => p.filename)).toEqual([
      "hg-002-styled-01.jpg",
      "hg-002-styled-02.jpg",
    ]);

    // Idempotent — a second sweep does not re-post or re-publish.
    await publishReadyFinals(deps());
    expect(slack.postsOfKind("finals-published")).toHaveLength(1);
    expect(repo.listPublishedForRequest("r1")).toHaveLength(2);
  });

  it("publishReadyFinals fails the Request if every Final generation died", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));
    gen.failEverything();
    await startApprovedFinals(deps());
    await resolvePendingGenerations(deps());
    await publishReadyFinals(deps());

    expect(repo.getRequest("r1")?.status).toBe("failed");
    const post = slack.postsOfKind("finals-published")[0];
    expect(post?.meta?.["status"]).toBe("failed");
    expect(post?.text ?? "").toContain("every Finals generation failed");
    // spend still booked on the dead attempts (DOMAIN.md)
    expect(repo.totalSpendCents()).toBe(
      11 * config.pipeline.finalsPerDirection,
    );
  });

  it("publishReadyFinals publishes the survivor and Parks a partially-failed Request", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));
    gen.enableManualCompletion();
    await startApprovedFinals(deps());
    const genIds = gen.creates.map((c) => c.generationId);

    gen.failGeneration(genIds[1] ?? ""); // one dies
    gen.markComplete(genIds[0] ?? "");
    await resolvePendingGenerations(deps());
    await publishReadyFinals(deps());

    expect(repo.getRequest("r1")?.status).toBe("parked");
    expect(repo.listPublishedForRequest("r1")).toHaveLength(1);
    expect(repo.listPublishedForRequest("r1")[0]?.filename).toBe(
      "hg-002-styled-01.jpg",
    );
    const post = slack.postsOfKind("finals-published")[0];
    expect(post?.meta?.["status"]).toBe("parked");
    expect(post?.text ?? "").toContain("parked");
    // spend still booked on both, including the dead one (DOMAIN.md)
    expect(repo.totalSpendCents()).toBe(
      11 * config.pipeline.finalsPerDirection,
    );
  });

  it("settles an orphaned final attempt (its Request row is gone) without re-hosting", async () => {
    const handle = await gen.create({
      prompt: "p",
      sourceImageUrl: "https://x/y.jpg",
      quality: "final",
    });
    repo.saveAttempt({
      id: "af-orphan",
      requestId: "r-gone",
      kind: "final",
      promptText: "p",
      inputPhotoUrl: "https://catalog.test/x.jpg",
      lumaGenerationId: handle.id,
      resultImageUrl: null,
      spendCents: 11,
      status: "pending",
      rejectReason: null,
      createdAt: "2026-09-06T12:00:00.000Z",
      completedAt: null,
    });

    await resolvePendingGenerations(deps());

    expect(repo.getAttempt("af-orphan")?.status).toBe("succeeded");
    expect(repo.getAttempt("af-orphan")?.resultImageUrl).toBeNull();
    expect(store.stored).toHaveLength(0);
  });

  it("the whole Finals arc is idempotent under repeated runPipelineTick", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));

    await runPipelineTick(deps());
    await runPipelineTick(deps());
    await runPipelineTick(deps());

    expect(
      repo.listAttemptsForRequest("r1").filter((a) => a.kind === "final"),
    ).toHaveLength(config.pipeline.finalsPerDirection);
    expect(slack.postsOfKind("finals-published")).toHaveLength(1);
    expect(repo.totalSpendCents()).toBe(
      11 * config.pipeline.finalsPerDirection,
    );
    expect(repo.getRequest("r1")?.status).toBe("done");
  });

  it("a Slack failure posting the completion leaves the Request finalizing for the next tick", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));
    await startApprovedFinals(deps());
    await resolvePendingGenerations(deps());

    slack.failNext("finals-published");
    await publishReadyFinals({ ...deps(), onItemError: () => undefined });
    expect(repo.getRequest("r1")?.status).toBe("finalizing");
    expect(slack.postsOfKind("finals-published")).toHaveLength(0);

    await publishReadyFinals(deps()); // healthy now
    expect(repo.getRequest("r1")?.status).toBe("done");
    expect(slack.postsOfKind("finals-published")).toHaveLength(1);
  });

  it("publishReadyFinals leaves a finalizing Request untouched when it has no final attempts yet", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "finalizing" }));

    await publishReadyFinals(deps());

    expect(repo.getRequest("r1")?.status).toBe("finalizing");
    expect(slack.posts).toHaveLength(0);
  });

  it("publishReadyFinals caps publishing at finalsPerDirection even if extra final attempts exist", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "finalizing" }));
    for (let i = 0; i < 5; i += 1) {
      const handle = await gen.create({
        prompt: "p",
        sourceImageUrl: "https://x/y.jpg",
        quality: "final",
      });
      repo.saveAttempt({
        id: `af${i}`,
        requestId: "r1",
        kind: "final",
        promptText: "p",
        inputPhotoUrl: "https://catalog.test/hg-002.jpg",
        lumaGenerationId: handle.id,
        resultImageUrl: `https://pipeline.test/img/hg-002-final-af${i}.jpg`,
        spendCents: 11,
        status: "succeeded",
        rejectReason: null,
        createdAt: `2026-09-06T12:0${i}:00.000Z`,
        completedAt: `2026-09-06T12:0${i}:30.000Z`,
      });
    }

    await publishReadyFinals(deps());

    const posts = slack.postsOfKind("finals-published");
    expect(posts).toHaveLength(1);
    expect((posts[0]?.meta?.["published"] as unknown[]).length).toBe(
      config.pipeline.finalsPerDirection,
    );
    expect(repo.getRequest("r1")?.status).toBe("done");
    expect(repo.listPublishedForRequest("r1")).toHaveLength(
      config.pipeline.finalsPerDirection,
    );
  });

  it("resolvePendingGenerations skips a pending attempt with no lumaGenerationId, without throwing", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "finalizing" }));
    repo.saveAttempt({
      id: "af1",
      requestId: "r1",
      kind: "final",
      promptText: "p",
      inputPhotoUrl: "https://catalog.test/hg-002.jpg",
      lumaGenerationId: null,
      resultImageUrl: null,
      spendCents: 11,
      status: "pending",
      rejectReason: null,
      createdAt: "2026-09-06T12:00:00.000Z",
      completedAt: null,
    });

    await resolvePendingGenerations(deps());

    expect(repo.getAttempt("af1")?.status).toBe("pending");
    expect(store.stored).toHaveLength(0);
  });

  it("the all-Finals-failed notice is posted before the Request is marked failed (a Slack throw keeps it retryable)", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));
    gen.failEverything();
    await startApprovedFinals(deps());
    await resolvePendingGenerations(deps());

    slack.failNext("finals-published");
    await publishReadyFinals({ ...deps(), onItemError: () => undefined });
    expect(repo.getRequest("r1")?.status).toBe("finalizing"); // NOT failed — message threw first

    await publishReadyFinals(deps()); // healthy now
    expect(repo.getRequest("r1")?.status).toBe("failed");
    expect(slack.postsOfKind("finals-published").at(-1)?.text ?? "").toContain(
      "every Finals generation failed",
    );
  });

  it("runPipelineTick carries an approved Request all the way to done with a hyperlinked completion message", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "approved" }));

    await runPipelineTick(deps());

    expect(repo.getRequest("r1")?.status).toBe("done");
    expect(slack.postsOfKind("finals-published")).toHaveLength(1);
  });

  it("stops issuing new generations while the shared in-flight budget is full", async () => {
    repo.upsertProduct(product("HG-002"));
    openBatch("HG-002");
    repo.saveRequest(request("r1", "HG-002", { status: "confirmed" }));
    for (let i = 0; i < config.pipeline.maxInFlightGenerations; i += 1) {
      repo.saveAttempt({
        id: `pending-${i}`,
        requestId: "r-other",
        kind: "draft",
        promptText: "p",
        inputPhotoUrl: "https://catalog.test/x.jpg",
        lumaGenerationId: `gen-${i}`,
        resultImageUrl: null,
        spendCents: 5,
        status: "pending",
        rejectReason: null,
        createdAt: `2026-09-06T12:0${i}:00.000Z`,
        completedAt: null,
      });
    }

    const started = await startConfirmedDrafts(deps());

    expect(started).toBe(0);
    expect(gen.creates).toHaveLength(0);
    expect(repo.getRequest("r1")?.status).toBe("confirmed");
  });

  describe("startRetryDrafts (F3b)", () => {
    it("kicks the one retry Draft for a Request the approver rejected once", async () => {
      repo.upsertProduct(product("HG-100"));
      openBatch("HG-100");
      // `drafting` + `retryUsed` with no attempt in flight = post-first-reject.
      repo.saveRequest(
        request("r1", "HG-100", { status: "drafting", retryUsed: true }),
      );
      repo.saveDecision({
        id: "d1",
        requestId: "r1",
        attemptId: null,
        actor: "U_APPROVER",
        verb: "reject",
        reason: "color off",
        at: "2026-09-06T12:30:00.000Z",
      });

      const started = await startRetryDrafts(deps());

      expect(started).toBe(1);
      expect(gen.creates).toHaveLength(1);
      expect(gen.creates[0]?.prompt).toContain("color off");
      const retries = repo
        .listAttemptsForRequest("r1")
        .filter((a) => a.kind === "retry");
      expect(retries).toHaveLength(1);
      expect(retries[0]?.status).toBe("pending");
    });

    it("leaves a fresh confirmed→drafting Request (retryUsed=false) alone", async () => {
      repo.upsertProduct(product("HG-100"));
      openBatch("HG-100");
      repo.saveRequest(
        request("r1", "HG-100", { status: "drafting", retryUsed: false }),
      );

      const started = await startRetryDrafts(deps());

      expect(started).toBe(0);
      expect(gen.creates).toHaveLength(0);
    });

    it("does not kick a second retry once one attempt exists", async () => {
      repo.upsertProduct(product("HG-100"));
      openBatch("HG-100");
      repo.saveRequest(
        request("r1", "HG-100", { status: "drafting", retryUsed: true }),
      );
      repo.saveAttempt({
        id: "a-retry-1",
        requestId: "r1",
        kind: "retry",
        promptText: "…",
        inputPhotoUrl: "https://catalog.test/hg-100.jpg",
        lumaGenerationId: "gen_prev",
        resultImageUrl: null,
        spendCents: 5,
        status: "pending",
        rejectReason: "color off",
        createdAt: "2026-09-06T12:40:00.000Z",
        completedAt: null,
      });

      const started = await startRetryDrafts(deps());

      expect(started).toBe(0);
      expect(gen.creates).toHaveLength(0);
    });

    it("a retryDraft throw is isolated — the tick is not aborted", async () => {
      openBatch("HG-100"); // note: no product upserted → retryDraft throws
      repo.saveRequest(
        request("r1", "HG-100", { status: "drafting", retryUsed: true }),
      );
      const errors: string[] = [];

      const started = await startRetryDrafts({
        ...deps(),
        onItemError: (context) => errors.push(context),
      });

      expect(started).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("retryDraft failed");
    });
  });
});
