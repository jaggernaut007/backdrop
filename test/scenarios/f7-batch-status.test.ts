/**
 * F7 — Batch status post & threaded review (Wave 7 / ADR 0019). Full lifecycle: one CSV upload ->
 * one status message covering every row -> each SKU's living thread reply moves ask -> draft ->
 * finals in place (not a new message per stage) -> once every row is terminal, the batch's CSV is
 * uploaded once, to the channel root (Wave 8 — was a thread reply).
 *
 * Drives the real use-cases end to end (no Bolt): `ingestCatalog`, `captureShotIdea`,
 * `startConfirmedDrafts` / `resolvePendingGenerations` / `startApprovedFinals` / `publishReadyFinals`
 * / `sweepOpenBatches`, `handleDecision`. Slack, Luma, and image hosting are faked at
 * the port boundary.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { captureShotIdea } from "../../src/app/capture-shot-idea.js";
import { handleDecision } from "../../src/app/handle-decision.js";
import { ingestCatalog } from "../../src/app/ingest-catalog.js";
import {
  publishReadyFinals,
  resolvePendingGenerations,
  startApprovedFinals,
  startConfirmedDrafts,
  sweepOpenBatches,
  type PipelineTickDeps,
} from "../../src/app/run-pipeline-tick.js";
import { loadConfig, type Config } from "../../src/config.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeGenerationClient } from "../fakes/fake-generation-client.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryImageStore } from "../fakes/in-memory-image-store.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const ELLIE = "U_APPROVER";

const ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C_TEST",
  APPROVER_SLACK_USER_ID: ELLIE,
  ESCALATION_SLACK_USER_ID: "U_ESCALATION",
  LUMA_AGENTS_API_KEY: "luma-api-test",
  DRAFT_COST_CENTS: "5",
  FINAL_COST_CENTS: "11",
};

describe("F7 — Batch status post & threaded review", () => {
  let repo: InMemoryRepository;
  let gen: FakeGenerationClient;
  let slack: FakeSlackGateway;
  let store: InMemoryImageStore;
  let clock: FakeClock;
  let config: Config;

  const tickDeps = (): PipelineTickDeps => ({
    repo,
    clock,
    generationClient: gen,
    imageStore: store,
    gateway: slack,
    config,
  });

  beforeEach(() => {
    repo = new InMemoryRepository();
    gen = new FakeGenerationClient();
    slack = new FakeSlackGateway();
    store = new InMemoryImageStore();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
    config = loadConfig(ENV);
  });

  const csv = [
    "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes",
    "HG-014,Table Runner,Textiles,Clay Pink,Linen,$42,https://x/hg-014.jpg,,",
    'HG-002,Stoneware Mug 12oz,Ceramics,Sage,Stoneware,$28,https://x/hg-002.jpg,"morning kitchen counter, steam, warm light",',
  ].join("\n");

  async function driveToApproved(sku: string, requestId: string): Promise<void> {
    await startConfirmedDrafts(tickDeps());
    await resolvePendingGenerations(tickDeps());
    const res = await handleDecision(
      { repo, clock, gateway: slack, config },
      { requestId, actor: ELLIE, verb: "approve" },
    );
    expect(res.applied).toBe(true);
    void sku;
  }

  async function driveToDone(requestId: string): Promise<void> {
    // Wave 9 throttle (ADR 0021): `maxFinalsStartsPerTick = 1`, and two same-timestamp
    // Requests tie-break on their random UUID id in queue order — so a single Finals pass may
    // finalize the OTHER approved SKU first. Drive the tick halves until THIS Request is
    // terminal, exactly as the production job loop drains the queue.
    for (let pass = 0; pass < 10; pass += 1) {
      await startApprovedFinals(tickDeps());
      await resolvePendingGenerations(tickDeps());
      await publishReadyFinals(tickDeps());
      if (repo.getRequest(requestId)?.status === "done") return;
    }
    expect(repo.getRequest(requestId)?.status).toBe("done");
  }

  it("one status message covers every row from the upload, and a blank row's ask is its living reply", async () => {
    const result = await ingestCatalog({ repo, slack, clock }, { csv, sourceRef: "F_TEST" });

    const batchPosts = slack.postsOfKind("batch-status");
    expect(batchPosts).toHaveLength(1);
    const rows = batchPosts[0]?.meta?.["rows"] as { sku: string }[];
    expect(rows.map((r) => r.sku).sort()).toEqual(["HG-002", "HG-014"]);

    const asks = slack.postsOfKind("blank-row-ask");
    expect(asks).toHaveLength(1); // only the blank row gets an ask
    expect(asks[0]?.meta?.["sku"]).toBe("HG-014");
    expect(asks[0]?.meta?.["threadTs"]).toBe(batchPosts[0]?.ts);

    const thread = repo.getSkuThreadPost(result.importId, "HG-014");
    expect(thread?.stage).toBe("ask");
    expect(thread?.slackTs).toBe(asks[0]?.ts);
  });

  it("a SKU's living reply is edited in place across ask -> draft -> finals, not re-posted", async () => {
    const result = await ingestCatalog({ repo, slack, clock }, { csv, sourceRef: "F_TEST" });
    const askTs = repo.getSkuThreadPost(result.importId, "HG-014")?.slackTs;

    await captureShotIdea(
      { repo, gateway: slack, clock },
      {
        sku: "HG-014",
        text: repo.getSkuThreadPost(result.importId, "HG-014")?.proposedText ?? "",
        origin: "proposed",
        importId: result.importId,
      },
    );
    const requestId = repo.getActiveRequestForSku("HG-014")?.id as string;

    await driveToApproved("HG-014", requestId);
    const afterDraft = repo.getSkuThreadPost(result.importId, "HG-014");
    expect(afterDraft?.stage).toBe("draft");
    expect(afterDraft?.slackTs).toBe(askTs); // same message, edited in place

    await driveToDone(requestId);
    const afterFinals = repo.getSkuThreadPost(result.importId, "HG-014");
    expect(afterFinals?.stage).toBe("published");
    expect(afterFinals?.slackTs).toBe(askTs); // still the same message

    // One `blank-row-ask` post (the original) for HG-014, then updates recorded at that same ts
    // for its draft and finals stages — never a second brand-new message for this SKU. HG-002 (the
    // sheet-origin row) is also progressing in the background — filter to HG-014's own posts.
    expect(slack.postsOfKind("blank-row-ask")).toHaveLength(1);
    const draftPosts = slack
      .postsOfKind("draft-review")
      .filter((p) => p.meta?.["sku"] === "HG-014");
    expect(draftPosts).toHaveLength(1);
    expect(draftPosts[0]?.updated).toBe(true);
    expect(draftPosts[0]?.ts).toBe(askTs);
    const finalsPosts = slack
      .postsOfKind("finals-published")
      .filter((p) => p.meta?.["sku"] === "HG-014");
    expect(finalsPosts).toHaveLength(1);
    expect(finalsPosts[0]?.updated).toBe(true);
    expect(finalsPosts[0]?.ts).toBe(askTs);
  });

  it("once every row in the batch is done, the completion CSV is uploaded exactly once to the channel", async () => {
    const result = await ingestCatalog({ repo, slack, clock }, { csv, sourceRef: "F_TEST" });

    await captureShotIdea(
      { repo, gateway: slack, clock },
      {
        sku: "HG-014",
        text: repo.getSkuThreadPost(result.importId, "HG-014")?.proposedText ?? "",
        origin: "proposed",
        importId: result.importId,
      },
    );

    const r014 = repo.getActiveRequestForSku("HG-014")?.id as string;
    const r002 = repo.getActiveRequestForSku("HG-002")?.id as string;

    await driveToApproved("HG-014", r014);
    await driveToApproved("HG-002", r002);
    // Not complete yet — nothing uploaded.
    expect(slack.postsOfKind("csv-upload")).toHaveLength(0);

    await driveToDone(r014);
    await driveToDone(r002);

    const uploads = slack.postsOfKind("csv-upload");
    expect(uploads).toHaveLength(1);
    // Posted to the channel root, not the batch thread (Wave 8).
    expect(uploads[0]?.channel).toBe("C_TEST");
    expect(uploads[0]?.meta?.["threadTs"]).toBeUndefined();
    const content = uploads[0]?.meta?.["content"] as string;
    expect(content).toContain(
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes,Status,Final Image URL",
    );
    expect(content).toContain("HG-014");
    expect(content).toContain("HG-002");
    // Every row's Shot Idea is filled in and its Status is the terminal outcome.
    const lines = content.trim().split("\n").slice(1);
    for (const line of lines) {
      expect(line).toContain(",done,");
    }

    const post = repo.getBatchStatusPost(result.importId);
    expect(post?.completedAt).not.toBeNull();
    expect(post?.exportUploadedAt).not.toBeNull();

    // A second, unrelated refresh (e.g. the periodic sweep) doesn't re-upload.
    await sweepOpenBatches(tickDeps());
    expect(slack.postsOfKind("csv-upload")).toHaveLength(1);
  });
});
