import { afterEach, describe, expect, it } from "vitest";

import { SqliteRepository } from "../../src/adapters/sqlite-repository.js";
import type {
  BatchStatusPost,
  CatalogImport,
  Decision,
  GenerationAttempt,
  Product,
  PublishedImage,
  ReviewPost,
  ShotRequest,
  SkuThreadPost,
} from "../../src/domain/types.js";
import type { Repository } from "../../src/ports/repository.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const T0 = "2026-09-06T12:00:00.000Z";

// --- fixture builders ------------------------------------------------------
function catalogImport(
  id: string,
  hash: string,
  over: Partial<CatalogImport> = {},
): CatalogImport {
  return {
    id,
    receivedAt: T0,
    sourceRef: "F_TEST",
    contentHash: hash,
    rowCount: 40,
    nWithIdea: 16,
    nBlank: 24,
    nDone: 0,
    ...over,
  };
}
function product(sku: string, over: Partial<Product> = {}): Product {
  return {
    sku,
    name: `${sku} name`,
    category: "Ceramics",
    colorRaw: "Sage",
    colorSet: { matched: ["Sage"], unmatched: [] },
    material: "Stoneware",
    priceCents: 2800,
    photoUrl: `https://x/${sku}.jpg`,
    notesRaw: "",
    updatedAt: T0,
    ...over,
  };
}
function request(id: string, over: Partial<ShotRequest> = {}): ShotRequest {
  return {
    id,
    sku: "HG-001",
    ideaRevision: 1,
    status: "confirmed",
    shotIdeaText: "an idea",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: T0,
    draftPostedAt: null,
    escalatedAt: null,
    ...over,
  };
}
function attempt(
  id: string,
  requestId: string,
  over: Partial<GenerationAttempt> = {},
): GenerationAttempt {
  return {
    id,
    requestId,
    kind: "draft",
    promptText: "a prompt",
    inputPhotoUrl: "https://x/in.jpg",
    lumaGenerationId: null,
    resultImageUrl: null,
    spendCents: 5,
    status: "pending",
    rejectReason: null,
    createdAt: T0,
    completedAt: null,
    ...over,
  };
}
function reviewPost(
  id: string,
  requestId: string,
  over: Partial<ReviewPost> = {},
): ReviewPost {
  return {
    id,
    requestId,
    attemptId: `att-${id}`,
    slackChannel: "C_TEST",
    slackTs: `170000000.${id}`,
    kind: "draft",
    createdAt: T0,
    ...over,
  };
}
function decision(
  id: string,
  requestId: string,
  over: Partial<Decision> = {},
): Decision {
  return {
    id,
    requestId,
    attemptId: null,
    actor: "U_APPROVER",
    verb: "approve",
    reason: null,
    at: T0,
    ...over,
  };
}
function batchStatusPost(
  importId: string,
  over: Partial<BatchStatusPost> = {},
): BatchStatusPost {
  return {
    importId,
    slackChannel: "C_TEST",
    slackTs: `1700000000.${importId}`,
    completedAt: null,
    exportUploadedAt: null,
    ...over,
  };
}
function skuThreadPost(
  importId: string,
  sku: string,
  over: Partial<SkuThreadPost> = {},
): SkuThreadPost {
  return {
    importId,
    sku,
    slackChannel: "C_TEST",
    slackTs: `1700000000.${importId}.${sku}`,
    stage: "ask",
    requestId: null,
    proposedText: "a proposal",
    updatedAt: T0,
    ...over,
  };
}
function published(
  filename: string,
  requestId: string,
  sequence: number,
): PublishedImage {
  return {
    filename,
    requestId,
    sourceAttemptId: `att-${filename}`,
    sequence,
    stableUrl: `https://pipeline.test/img/${filename}`,
    publishedAt: T0,
  };
}

// --- the contract -------------------------------------------------------
function runRepositoryContract(name: string, make: () => Repository): void {
  describe(`Repository contract: ${name}`, () => {
    it("stores and finds a CatalogImport by content hash", () => {
      const repo = make();
      expect(repo.findImportByContentHash("h1")).toBeNull();
      repo.saveImport(catalogImport("imp1", "h1"));
      expect(repo.findImportByContentHash("h1")?.id).toBe("imp1");
      expect(repo.findImportByContentHash("nope")).toBeNull();
    });

    it("upserts Products last-writer-wins keyed by SKU, and lists them SKU-ascending", () => {
      const repo = make();
      repo.upsertProduct(product("HG-009", { priceCents: 100 }));
      repo.upsertProduct(product("HG-001"));
      repo.upsertProduct(product("HG-009", { priceCents: 200 })); // re-save, out of order
      expect(repo.getProduct("HG-009")?.priceCents).toBe(200);
      expect(repo.listProducts().map((p) => p.sku)).toEqual([
        "HG-001",
        "HG-009",
      ]);
      expect(repo.getProduct("HG-404")).toBeNull();
    });

    it("getRequest round-trips by id and returns null for an unknown id", () => {
      const repo = make();
      expect(repo.getRequest("nope")).toBeNull();
      repo.saveRequest(request("r1", { shotIdeaText: "a lit shelf" }));
      expect(repo.getRequest("r1")?.shotIdeaText).toBe("a lit shelf");
    });

    it("point lookups return null on a miss, never throw", () => {
      const repo = make();
      expect(repo.getAttempt("missing")).toBeNull();
      expect(repo.getProduct("missing")).toBeNull();
      expect(repo.getReviewPostBySlackTs("C_TEST", "0.0")).toBeNull();
      expect(repo.getBlankRowAskBySlackTs("C_TEST", "0.0")).toBeNull();
      expect(repo.getBlankRowAskBySku("missing")).toBeNull();
    });

    it("getActiveRequestForSku ignores terminal Requests; listRequestsForSku returns all", () => {
      const repo = make();
      repo.saveRequest(
        request("r1", { sku: "HG-9", status: "done", ideaRevision: 1 }),
      );
      expect(repo.getActiveRequestForSku("HG-9")).toBeNull();

      repo.saveRequest(
        request("r3", { sku: "HG-9", status: "confirmed", ideaRevision: 3 }),
      );
      repo.saveRequest(
        request("r2", { sku: "HG-9", status: "stale", ideaRevision: 2 }),
      );
      // two non-terminal rows -> the highest idea revision wins (`stale` is not terminal)
      expect(repo.getActiveRequestForSku("HG-9")?.id).toBe("r3");
      expect(repo.listRequestsForSku("HG-9").map((r) => r.id)).toEqual([
        "r1",
        "r2",
        "r3",
      ]);
      expect(repo.listRequestsForSku("HG-nope")).toEqual([]);
    });

    it("listRequestsByStatus filters to one status and orders createdAt asc then id asc", () => {
      const repo = make();
      repo.saveRequest(
        request("z", {
          status: "confirmed",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      repo.saveRequest(
        request("a", {
          status: "confirmed",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      repo.saveRequest(request("p", { status: "parked" }));
      expect(repo.listRequestsByStatus("confirmed").map((r) => r.id)).toEqual([
        "a",
        "z",
      ]);
      expect(repo.listRequestsByStatus("parked").map((r) => r.id)).toEqual([
        "p",
      ]);
    });

    it("listRequestsInQueueOrder: priority desc, then createdAt asc, then id asc; terminal excluded", () => {
      const repo = make();
      repo.saveRequest(
        request("b", {
          priorityRank: 0,
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      repo.saveRequest(
        request("a", {
          priorityRank: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      repo.saveRequest(
        request("p", {
          priorityRank: 100,
          createdAt: "2026-01-03T00:00:00.000Z",
        }),
      );
      repo.saveRequest(
        request("t1", {
          priorityRank: 100,
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "done",
        }),
      );
      repo.saveRequest(
        request("c", {
          priorityRank: 0,
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      expect(repo.listRequestsInQueueOrder().map((r) => r.id)).toEqual([
        "p",
        "a",
        "b",
        "c",
      ]);
    });

    it("attempts: round-trip, per-request ordering by createdAt then id, and the pending filter (also ordered)", () => {
      const repo = make();
      repo.saveAttempt(
        attempt("a2", "r1", {
          createdAt: "2026-01-02T00:00:00.000Z",
          status: "failed",
        }),
      );
      repo.saveAttempt(
        attempt("a1", "r1", {
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "succeeded",
        }),
      );
      repo.saveAttempt(
        attempt("p2", "r2", {
          createdAt: "2026-01-02T00:00:00.000Z",
          status: "pending",
        }),
      );
      repo.saveAttempt(
        attempt("p1", "r2", {
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "pending",
        }),
      );
      expect(repo.listAttemptsForRequest("r1").map((a) => a.id)).toEqual([
        "a1",
        "a2",
      ]);
      expect(repo.getAttempt("p1")?.requestId).toBe("r2");
      expect(repo.listPendingAttempts().map((a) => a.id)).toEqual(["p1", "p2"]);
    });

    it("review posts: lookup by slack ts, and latest-per-request by createdAt", () => {
      const repo = make();
      repo.saveReviewPost(
        reviewPost("rp1", "r1", {
          slackTs: "111.1",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      repo.saveReviewPost(
        reviewPost("rp2", "r1", {
          slackTs: "222.2",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      expect(repo.getReviewPostBySlackTs("C_TEST", "111.1")?.id).toBe("rp1");
      expect(repo.getReviewPostBySlackTs("C_TEST", "999.9")).toBeNull();
      expect(repo.getLatestReviewPostForRequest("r1", "draft")?.id).toBe("rp2");
      expect(repo.getLatestReviewPostForRequest("r1", "finals")).toBeNull();
    });

    it("review posts: a second row at the same (channel, ts, kind) is rejected; a different kind at that ts is allowed", () => {
      const repo = make();
      repo.saveReviewPost(reviewPost("rp1", "r1", { slackTs: "500.5" }));
      // Same (channel, ts, kind) via a NEW id — the widened UNIQUE index (Wave 7) must reject it.
      // This is the retry-Draft bug: it must reuse rp1's id, not insert a fresh one.
      expect(() =>
        repo.saveReviewPost(reviewPost("rp2", "r1", { slackTs: "500.5" })),
      ).toThrow(/UNIQUE constraint failed/);
      // Reusing the id (upsert) is fine — same row, new attempt.
      repo.saveReviewPost(
        reviewPost("rp1", "r1", { slackTs: "500.5", attemptId: "att-retry" }),
      );
      expect(repo.getReviewPostBySlackTs("C_TEST", "500.5")?.attemptId).toBe(
        "att-retry",
      );
      // A `finals` row at the SAME (channel, ts) is allowed — the point of widening the index.
      repo.saveReviewPost(
        reviewPost("rp3", "r1", { slackTs: "500.5", kind: "finals" }),
      );
      expect(repo.getLatestReviewPostForRequest("r1", "finals")?.id).toBe("rp3");
    });

    it("decisions: list per request ordered by `at` then id, and a re-save by id is an upsert", () => {
      const repo = make();
      repo.saveDecision(
        decision("d2", "r1", {
          verb: "approve",
          at: "2026-01-02T00:00:00.000Z",
        }),
      );
      repo.saveDecision(
        decision("d1", "r1", {
          verb: "reject",
          reason: "too staged",
          at: "2026-01-01T00:00:00.000Z",
        }),
      );
      repo.saveDecision(decision("d3", "r2", { verb: "approve" }));
      expect(repo.listDecisionsForRequest("r1").map((d) => d.id)).toEqual([
        "d1",
        "d2",
      ]);
      expect(repo.listDecisionsForRequest("r1")[0]?.reason).toBe("too staged");

      // same id again — must replace, not append (port: "last-writer-wins upserts keyed by identity")
      repo.saveDecision(
        decision("d1", "r1", {
          verb: "reject",
          reason: "wrong vibe",
          at: "2026-01-01T00:00:00.000Z",
        }),
      );
      expect(repo.listDecisionsForRequest("r1").map((d) => d.id)).toEqual([
        "d1",
        "d2",
      ]);
      expect(repo.listDecisionsForRequest("r1")[0]?.reason).toBe("wrong vibe");
    });

    it("published images list by ascending sequence", () => {
      const repo = make();
      repo.savePublishedImage(published("hg-002-styled-02.jpg", "r1", 2));
      repo.savePublishedImage(published("hg-002-styled-01.jpg", "r1", 1));
      expect(repo.listPublishedForRequest("r1").map((p) => p.sequence)).toEqual(
        [1, 2],
      );
      expect(repo.listPublishedForRequest("r1")[0]?.filename).toBe(
        "hg-002-styled-01.jpg",
      );
    });

    it("savePublishedImage is last-writer-wins by filename and round-trips every field", () => {
      const repo = make();
      repo.savePublishedImage(published("hg-002-styled-01.jpg", "r1", 1));
      repo.savePublishedImage({
        ...published("hg-002-styled-01.jpg", "r1", 1),
        sourceAttemptId: "att-rehosted",
        stableUrl: "https://pipeline.test/img/hg-002-styled-01.jpg?v=2",
      });

      const rows = repo.listPublishedForRequest("r1");
      expect(rows).toHaveLength(1); // idempotent re-publish overwrites, not appends (ADR 0008)
      expect(rows[0]).toEqual({
        filename: "hg-002-styled-01.jpg",
        requestId: "r1",
        sourceAttemptId: "att-rehosted",
        sequence: 1,
        stableUrl: "https://pipeline.test/img/hg-002-styled-01.jpg?v=2",
        publishedAt: T0,
      });
      expect(repo.listPublishedForRequest("r-unknown")).toEqual([]);
    });

    it("blank-row asks resolve by slack ts and by sku", () => {
      const repo = make();
      repo.saveBlankRowAsk({
        sku: "HG-014",
        slackChannel: "C_TEST",
        slackTs: "999.9",
        proposedText: "folded on a sunlit oak table",
      });
      expect(repo.getBlankRowAskBySlackTs("C_TEST", "999.9")?.sku).toBe(
        "HG-014",
      );
      expect(repo.getBlankRowAskBySku("HG-014")?.proposedText).toBe(
        "folded on a sunlit oak table",
      );
      expect(repo.getBlankRowAskBySku("HG-000")).toBeNull();
    });

    // --- F7 / ADR 0019 ---------------------------------------------------

    it("catalog import rows: registers every SKU once, lists them, and de-dupes a re-save", () => {
      const repo = make();
      repo.saveImport(catalogImport("imp1", "h1"));
      repo.saveImport(catalogImport("imp2", "h2"));
      repo.saveCatalogImportRow("imp1", "HG-001");
      repo.saveCatalogImportRow("imp1", "HG-002");
      repo.saveCatalogImportRow("imp1", "HG-001"); // re-save (ingest re-run) — no duplicate
      repo.saveCatalogImportRow("imp2", "HG-001");

      expect(repo.listSkusForImport("imp1")).toEqual(["HG-001", "HG-002"]);
      expect(repo.listSkusForImport("imp-nope")).toEqual([]);
    });

    it("catalog import rows: a row for an import that was never saved is rejected (FK)", () => {
      const repo = make();
      // `ingest-catalog.ts` must `saveImport` before registering rows — the FK enforces it.
      expect(() => repo.saveCatalogImportRow("imp-ghost", "HG-001")).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      repo.saveImport(catalogImport("imp1", "h1"));
      expect(() => repo.saveCatalogImportRow("imp1", "HG-001")).not.toThrow();
    });

    it("listOpenImportIdsForSku: open = no status post yet, or one with completedAt unset", () => {
      const repo = make();
      repo.saveImport(catalogImport("imp1", "h1"));
      repo.saveImport(catalogImport("imp2", "h2"));
      repo.saveCatalogImportRow("imp1", "HG-001");
      repo.saveCatalogImportRow("imp2", "HG-001");

      // Neither batch has a status post yet — both count as open.
      expect(repo.listOpenImportIdsForSku("HG-001")).toEqual(["imp1", "imp2"]);

      repo.saveBatchStatusPost(batchStatusPost("imp1"));
      expect(repo.listOpenImportIdsForSku("HG-001")).toEqual(["imp1", "imp2"]);

      repo.markBatchCompleted("imp1", T0);
      expect(repo.listOpenImportIdsForSku("HG-001")).toEqual(["imp2"]);

      expect(repo.listOpenImportIdsForSku("HG-nope")).toEqual([]);
    });

    it("batch status posts: round-trip by import id and by slack ts, and the completion/export markers", () => {
      const repo = make();
      repo.saveImport(catalogImport("imp1", "h1"));
      expect(repo.getBatchStatusPost("imp1")).toBeNull();
      expect(repo.getBatchStatusPostBySlackTs("C_TEST", "1700000000.imp1")).toBeNull();

      repo.saveBatchStatusPost(batchStatusPost("imp1"));
      expect(repo.getBatchStatusPost("imp1")?.slackChannel).toBe("C_TEST");
      expect(
        repo.getBatchStatusPostBySlackTs("C_TEST", "1700000000.imp1")?.importId,
      ).toBe("imp1");
      expect(repo.getBatchStatusPost("imp1")?.completedAt).toBeNull();
      expect(repo.getBatchStatusPost("imp1")?.exportUploadedAt).toBeNull();

      repo.markBatchCompleted("imp1", "2026-09-06T13:00:00.000Z");
      expect(repo.getBatchStatusPost("imp1")?.completedAt).toBe(
        "2026-09-06T13:00:00.000Z",
      );
      repo.markBatchExportUploaded("imp1", "2026-09-06T13:05:00.000Z");
      expect(repo.getBatchStatusPost("imp1")?.exportUploadedAt).toBe(
        "2026-09-06T13:05:00.000Z",
      );
      // Re-saving is a last-writer-wins upsert keyed by importId.
      repo.saveBatchStatusPost(batchStatusPost("imp1", { slackTs: "999.999" }));
      expect(repo.getBatchStatusPost("imp1")?.slackTs).toBe("999.999");
    });

    it("listOpenBatches: no status post yet, or completedAt unset; excludes completed batches", () => {
      const repo = make();
      repo.saveImport(catalogImport("imp1", "h1", { receivedAt: "2026-01-01T00:00:00.000Z" }));
      repo.saveImport(catalogImport("imp2", "h2", { receivedAt: "2026-01-02T00:00:00.000Z" }));
      repo.saveImport(catalogImport("imp3", "h3", { receivedAt: "2026-01-03T00:00:00.000Z" }));
      repo.saveBatchStatusPost(batchStatusPost("imp2"));
      repo.saveBatchStatusPost(batchStatusPost("imp3"));
      repo.markBatchCompleted("imp3", T0);

      // imp1 (no post yet) and imp2 (posted, not completed) are open; imp3 is not. Oldest first.
      expect(repo.listOpenBatches().map((i) => i.id)).toEqual(["imp1", "imp2"]);
    });

    it("sku thread posts: round-trip by (importId, sku) and by slack ts; last-writer-wins upsert", () => {
      const repo = make();
      repo.saveImport(catalogImport("imp1", "h1"));
      repo.saveImport(catalogImport("imp2", "h2"));
      expect(repo.getSkuThreadPost("imp1", "HG-001")).toBeNull();
      expect(repo.getSkuThreadPostBySlackTs("C_TEST", "1700000000.imp1.HG-001")).toBeNull();

      repo.saveSkuThreadPost(skuThreadPost("imp1", "HG-001"));
      expect(repo.getSkuThreadPost("imp1", "HG-001")?.stage).toBe("ask");
      expect(
        repo.getSkuThreadPostBySlackTs("C_TEST", "1700000000.imp1.HG-001")?.sku,
      ).toBe("HG-001");

      // Same {importId, sku} — the living reply is edited in place, not duplicated.
      repo.saveSkuThreadPost(
        skuThreadPost("imp1", "HG-001", { stage: "draft", requestId: "r1" }),
      );
      expect(repo.getSkuThreadPost("imp1", "HG-001")?.stage).toBe("draft");
      expect(repo.getSkuThreadPost("imp1", "HG-001")?.requestId).toBe("r1");

      // A different import for the same SKU is a distinct row.
      repo.saveSkuThreadPost(skuThreadPost("imp2", "HG-001"));
      expect(repo.getSkuThreadPost("imp2", "HG-001")?.stage).toBe("ask");
      expect(repo.getSkuThreadPost("imp1", "HG-001")?.stage).toBe("draft"); // unaffected
    });

    it("totalSpendCents sums every attempt — success, failure, and pending", () => {
      const repo = make();
      repo.saveAttempt(
        attempt("a1", "r1", { spendCents: 5, status: "succeeded" }),
      );
      repo.saveAttempt(
        attempt("a2", "r1", { spendCents: 5, status: "failed" }),
      );
      repo.saveAttempt(
        attempt("a3", "r1", { spendCents: 11, status: "pending" }),
      );
      expect(repo.totalSpendCents()).toBe(21);
    });
  });
}

const openDbs: SqliteRepository[] = [];
afterEach(() => {
  for (const r of openDbs.splice(0)) r.close();
});

runRepositoryContract("InMemoryRepository", () => new InMemoryRepository());
runRepositoryContract("SqliteRepository", () => {
  const r = new SqliteRepository(":memory:");
  r.migrate();
  openDbs.push(r);
  return r;
});
