/**
 * F4 — Finals & publish. Scenario names are SPEC.md verbatim.
 *
 * Slack + Luma + the image store are faked at the port boundary; the pipeline runs in-process:
 * `startApprovedFinals` (kick 2 finals) → `resolvePendingGenerations` (poll → re-host) →
 * `publishReadyFinals` (auto-publish each succeeded Final under its deterministic name and move
 * `finalizing → done` | `parked` | `failed`, posting the hyperlinked completion message into the
 * SKU's living thread reply).
 *
 * `DraftApproved` is the only authoriser of Finals spend: `runFinals` (via `beginFinals`) throws
 * unless the Request is `approved`, so a Request that was never approved generates nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { toColorSet } from "../../src/domain/colorset.js";
import type { Product, ShotRequest } from "../../src/domain/types.js";
import {
  publishReadyFinals,
  resolvePendingGenerations,
  runPipelineTick,
  startApprovedFinals,
  type PipelineTickDeps,
} from "../../src/app/run-pipeline-tick.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeGenerationClient } from "../fakes/fake-generation-client.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryImageStore } from "../fakes/in-memory-image-store.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const ELLIE = "U_APPROVER";

const TEST_ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C_TEST",
  APPROVER_SLACK_USER_ID: ELLIE,
  ESCALATION_SLACK_USER_ID: "U_ESCALATION",
  LUMA_AGENTS_API_KEY: "luma-api-test",
  DRAFT_COST_CENTS: "5",
  FINAL_COST_CENTS: "11",
};

describe("F4 — Finals & publish", () => {
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
    priceCents: 4800,
    photoUrl: "https://catalog.test/assets/hg-002.jpg",
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
    ...over,
  });

  const approvedRequest = (over: Partial<ShotRequest> = {}): ShotRequest => ({
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

  beforeEach(() => {
    repo = new InMemoryRepository();
    gen = new FakeGenerationClient();
    slack = new FakeSlackGateway();
    store = new InMemoryImageStore();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
    config = loadConfig(TEST_ENV);
  });

  it("An approved direction generates two Finals", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(approvedRequest());

    await startApprovedFinals(deps());

    const finalCreates = gen.creates.filter((c) => c.quality === "final");
    expect(finalCreates).toHaveLength(2);
    const attempts = repo
      .listAttemptsForRequest("r1")
      .filter((a) => a.kind === "final");
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.status === "pending")).toBe(true);
    expect(attempts.every((a) => a.spendCents === 11)).toBe(true);
    expect(repo.getRequest("r1")?.status).toBe("finalizing");
  });

  it("Finals are never generated without an approved direction", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(approvedRequest({ id: "r-review", status: "in_review" }));
    repo.saveRequest(
      approvedRequest({ id: "r-parked", status: "parked", ideaRevision: 2 }),
    );
    const spendBefore = repo.totalSpendCents();

    await runPipelineTick(deps());

    expect(gen.creates.filter((c) => c.quality === "final")).toHaveLength(0);
    expect(
      repo.listAttemptsForRequest("r-review").filter((a) => a.kind === "final"),
    ).toHaveLength(0);
    expect(
      repo.listAttemptsForRequest("r-parked").filter((a) => a.kind === "final"),
    ).toHaveLength(0);
    expect(repo.totalSpendCents()).toBe(spendBefore);
    expect(repo.getRequest("r-review")?.status).toBe("in_review");
    expect(repo.getRequest("r-parked")?.status).toBe("parked");
  });

  it("Completed Finals are auto-published and the Request is Done", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(approvedRequest());

    await startApprovedFinals(deps());
    await resolvePendingGenerations(deps());
    await publishReadyFinals(deps());

    expect(repo.getRequest("r1")?.status).toBe("done");

    const published = repo.listPublishedForRequest("r1");
    expect(published.map((p) => p.filename)).toEqual([
      "hg-002-styled-01.jpg",
      "hg-002-styled-02.jpg",
    ]);
    expect(published[0]?.stableUrl).toContain("/img/hg-002-styled-01.jpg");
    expect(published[1]?.stableUrl).toContain("/img/hg-002-styled-02.jpg");

    const picks = repo
      .listDecisionsForRequest("r1")
      .filter((d) => d.verb === "pick");
    expect(picks).toHaveLength(2);
    expect(picks.every((d) => d.actor === "system")).toBe(true);
  });

  it("A single completed Final is published and the Request is Parked, not Done", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(approvedRequest());

    await startApprovedFinals(deps());
    const attempts = repo
      .listAttemptsForRequest("r1")
      .filter((a) => a.kind === "final");
    gen.failGeneration(attempts[1]!.lumaGenerationId!);
    await resolvePendingGenerations(deps());
    await publishReadyFinals(deps());

    expect(repo.getRequest("r1")?.status).toBe("parked");
    expect(repo.getRequest("r1")?.status).not.toBe("done");
    expect(repo.listPublishedForRequest("r1")).toHaveLength(1);
    expect(repo.listPublishedForRequest("r1")[0]?.filename).toBe(
      "hg-002-styled-01.jpg",
    );
  });

  it("the Finals completion message hyperlinks each published image to its stable URL", async () => {
    repo.upsertProduct(product());
    openBatch();
    repo.saveRequest(approvedRequest());

    await startApprovedFinals(deps());
    await resolvePendingGenerations(deps());
    await publishReadyFinals(deps());

    const post = slack.postsOfKind("finals-published")[0];
    const published = post?.meta?.["published"] as {
      filename: string;
      stableUrl: string;
    }[];
    expect(published).toHaveLength(2);
    expect(post?.meta?.["status"]).toBe("done");

    const text = post?.text ?? "";
    expect(text).toContain("done");
    expect(text).toContain(
      `<${published[0]?.stableUrl}|${published[0]?.filename}>`,
    );
    expect(text).toContain(
      `<${published[1]?.stableUrl}|${published[1]?.filename}>`,
    );
    expect(text).toContain("hg-002-styled-01.jpg");
    expect(text).toContain("hg-002-styled-02.jpg");
  });
});
