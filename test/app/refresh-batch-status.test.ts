/**
 * F7 / ADR 0019 — `refreshBatchStatus` is the core of the batch status post feature: it's called
 * from every status-changing `saveRequest` across the app layer. These tests drive it directly
 * against `InMemoryRepository` + `FakeSlackGateway`, without going through the full pipeline.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  refreshBatchById,
  refreshBatchStatus,
} from "../../src/app/refresh-batch-status.js";
import type { Product, ShotRequest } from "../../src/domain/types.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

describe("refreshBatchStatus", () => {
  let repo: InMemoryRepository;
  let slack: FakeSlackGateway;
  let clock: FakeClock;

  const deps = () => ({ repo, slack, clock });

  const product = (sku: string, over: Partial<Product> = {}): Product => ({
    sku,
    name: `Product ${sku}`,
    category: "Ceramics",
    colorRaw: "Sage",
    colorSet: { matched: ["Sage"], unmatched: [] },
    material: "Stoneware",
    priceCents: 2800,
    photoUrl: `https://x/${sku}.jpg`,
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
    ...over,
  });

  const request = (
    sku: string,
    over: Partial<ShotRequest> = {},
  ): ShotRequest => ({
    id: `r-${sku}`,
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

  beforeEach(() => {
    repo = new InMemoryRepository();
    slack = new FakeSlackGateway();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
  });

  function openImport(importId: string, skus: string[]): void {
    repo.saveImport({
      id: importId,
      receivedAt: "2026-09-06T12:00:00.000Z",
      sourceRef: "F_TEST",
      contentHash: `hash-${importId}`,
      rowCount: skus.length,
      nWithIdea: skus.length,
      nBlank: 0,
      nDone: 0,
    });
    for (const sku of skus) repo.saveCatalogImportRow(importId, sku);
  }

  it("posts a fresh batch status message when none exists yet (self-heal)", async () => {
    openImport("imp1", ["HG-100"]);
    repo.upsertProduct(product("HG-100"));
    repo.saveRequest(request("HG-100", { status: "drafting" }));

    await refreshBatchStatus(deps(), "HG-100");

    const posts = slack.postsOfKind("batch-status");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.updated).toBeUndefined(); // a fresh post, not an update
    const rows = posts[0]?.meta?.["rows"] as { sku: string; label: string }[];
    expect(rows).toEqual([
      { sku: "HG-100", productName: "Product HG-100", label: expect.stringContaining("Drafting") },
    ]);
    expect(repo.getBatchStatusPost("imp1")?.slackTs).toBe(posts[0]?.ts);
  });

  it("updates the existing batch status post in place for a subsequent transition", async () => {
    openImport("imp1", ["HG-100"]);
    repo.upsertProduct(product("HG-100"));
    repo.saveRequest(request("HG-100", { status: "drafting" }));
    await refreshBatchStatus(deps(), "HG-100"); // posts fresh
    const firstTs = repo.getBatchStatusPost("imp1")?.slackTs;

    repo.saveRequest(request("HG-100", { status: "in_review" }));
    await refreshBatchStatus(deps(), "HG-100");

    const posts = slack.postsOfKind("batch-status");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.updated).toBe(true);
    expect(posts[1]?.ts).toBe(firstTs); // same message, edited in place
    const rows = posts[1]?.meta?.["rows"] as { label: string }[];
    expect(rows[0]?.label).toContain("Awaiting review");
  });

  it("a SKU open in two batches at once refreshes both", async () => {
    openImport("imp1", ["HG-100"]);
    openImport("imp2", ["HG-100"]);
    repo.upsertProduct(product("HG-100"));
    repo.saveRequest(request("HG-100", { status: "drafting" }));

    await refreshBatchStatus(deps(), "HG-100");

    expect(repo.getBatchStatusPost("imp1")).not.toBeNull();
    expect(repo.getBatchStatusPost("imp2")).not.toBeNull();
    expect(slack.postsOfKind("batch-status")).toHaveLength(2);
  });

  it("a batch reaching all-terminal exports and uploads the CSV exactly once", async () => {
    openImport("imp1", ["HG-100", "HG-101"]);
    repo.upsertProduct(product("HG-100"));
    repo.upsertProduct(product("HG-101"));
    repo.saveRequest(request("HG-100", { status: "done" }));
    repo.saveRequest(request("HG-101", { status: "drafting" }));

    // Not complete yet — HG-101 is still active.
    await refreshBatchStatus(deps(), "HG-100");
    expect(slack.postsOfKind("csv-upload")).toHaveLength(0);
    expect(repo.getBatchStatusPost("imp1")?.completedAt).toBeNull();

    repo.saveRequest(request("HG-101", { status: "failed" }));
    await refreshBatchStatus(deps(), "HG-101");

    expect(slack.postsOfKind("csv-upload")).toHaveLength(1);
    const post = repo.getBatchStatusPost("imp1");
    expect(post?.completedAt).not.toBeNull();
    expect(post?.exportUploadedAt).not.toBeNull();

    // A later, unrelated call for the same (now-completed) batch doesn't re-upload.
    await refreshBatchStatus(deps(), "HG-100");
    expect(slack.postsOfKind("csv-upload")).toHaveLength(1);
  });

  it("a thrown Slack update doesn't throw out of refreshBatchStatus and doesn't touch durable state", async () => {
    openImport("imp1", ["HG-100"]);
    repo.upsertProduct(product("HG-100"));
    repo.saveRequest(request("HG-100", { status: "done" }));
    slack.failNext("batch-status");

    await expect(refreshBatchStatus(deps(), "HG-100")).resolves.toBeUndefined();

    // No batch status post was durably recorded — self-heals on the next successful call.
    expect(repo.getBatchStatusPost("imp1")).toBeNull();
    expect(repo.getRequest("r-HG-100")?.status).toBe("done"); // untouched
  });

  it("a SKU with no open batch is a silent no-op", async () => {
    repo.upsertProduct(product("HG-100"));
    repo.saveRequest(request("HG-100"));
    await expect(refreshBatchStatus(deps(), "HG-100")).resolves.toBeUndefined();
    expect(slack.postsOfKind("batch-status")).toHaveLength(0);
  });

  it("two concurrent refreshes of an un-posted batch post exactly one message (per-import lock)", async () => {
    // The ingest-window race: `catalog_import_rows` exist but `batch_status_posts` doesn't yet, so
    // both callers would take the self-heal "post fresh" branch. The lock serializes them.
    openImport("imp1", ["HG-100"]);
    repo.upsertProduct(product("HG-100"));
    repo.saveRequest(request("HG-100", { status: "drafting" }));

    await Promise.all([
      refreshBatchById(deps(), "imp1"),
      refreshBatchById(deps(), "imp1"),
    ]);

    const fresh = slack.postsOfKind("batch-status").filter((p) => !p.updated);
    expect(fresh).toHaveLength(1); // one post; the other caller edited it in place
    expect(repo.getBatchStatusPost("imp1")).not.toBeNull();
  });

  it("two concurrent refreshes of a just-completed batch upload the CSV exactly once (per-import lock)", async () => {
    openImport("imp1", ["HG-100"]);
    repo.upsertProduct(product("HG-100"));
    repo.saveRequest(request("HG-100", { status: "drafting" }));
    await refreshBatchStatus(deps(), "HG-100"); // batch post exists, not yet complete

    repo.saveRequest(request("HG-100", { status: "done" }));
    await Promise.all([
      refreshBatchById(deps(), "imp1"),
      refreshBatchById(deps(), "imp1"),
    ]);

    expect(slack.postsOfKind("csv-upload")).toHaveLength(1);
  });
});
