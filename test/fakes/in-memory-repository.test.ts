import { describe, expect, it } from "vitest";

import type {
  GenerationAttempt,
  ReviewPost,
  ShotRequest,
} from "../../src/domain/types.js";
import { InMemoryRepository } from "./in-memory-repository.js";

function mkReq(id: string, over: Partial<ShotRequest> = {}): ShotRequest {
  return {
    id,
    sku: `SKU-${id}`,
    ideaRevision: 1,
    status: "confirmed",
    shotIdeaText: "on a kitchen counter",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    draftPostedAt: null,
    escalatedAt: null,
    ...over,
  };
}

function mkAttempt(
  id: string,
  over: Partial<GenerationAttempt> = {},
): GenerationAttempt {
  return {
    id,
    requestId: "r1",
    kind: "draft",
    promptText: "p",
    inputPhotoUrl: "https://x/y.jpg",
    lumaGenerationId: "gen_1",
    resultImageUrl: null,
    spendCents: 5,
    status: "pending",
    rejectReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...over,
  };
}

function mkReviewPost(id: string, over: Partial<ReviewPost> = {}): ReviewPost {
  return {
    id,
    requestId: "r1",
    attemptId: "a1",
    slackChannel: "C1",
    slackTs: `1700000000.${id}`,
    kind: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("InMemoryRepository", () => {
  it("orders the queue by priorityRank desc, then createdAt asc, then id", () => {
    const repo = new InMemoryRepository();
    repo.saveRequest(
      mkReq("low-early", {
        priorityRank: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    repo.saveRequest(
      mkReq("high-late", {
        priorityRank: 5,
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    );
    repo.saveRequest(
      mkReq("high-early", {
        priorityRank: 5,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    repo.saveRequest(
      mkReq("high-tie-b", {
        priorityRank: 5,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    expect(repo.listRequestsInQueueOrder().map((r) => r.id)).toEqual([
      "high-early",
      "high-tie-b",
      "high-late",
      "low-early",
    ]);
  });

  it("excludes terminal Requests from the queue", () => {
    const repo = new InMemoryRepository();
    repo.saveRequest(mkReq("active", { status: "confirmed" }));
    repo.saveRequest(mkReq("done", { status: "done" }));
    repo.saveRequest(mkReq("parked", { status: "parked" }));
    repo.saveRequest(mkReq("failed", { status: "failed" }));
    repo.saveRequest(mkReq("stale", { status: "stale" }));

    expect(
      repo
        .listRequestsInQueueOrder()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["active", "stale"]);
  });

  it("getActiveRequestForSku ignores terminal Requests but keeps 'stale' active", () => {
    const repo = new InMemoryRepository();
    repo.saveRequest(mkReq("r-done", { sku: "HG-002", status: "done" }));
    expect(repo.getActiveRequestForSku("HG-002")).toBeNull();

    repo.saveRequest(mkReq("r-stale", { sku: "HG-002", status: "stale" }));
    expect(repo.getActiveRequestForSku("HG-002")?.id).toBe("r-stale");
  });

  it("totalSpendCents counts failed attempts too (spend recorded even on failure)", () => {
    const repo = new InMemoryRepository();
    repo.saveAttempt(mkAttempt("a1", { status: "failed", spendCents: 5 }));
    repo.saveAttempt(mkAttempt("a2", { status: "succeeded", spendCents: 11 }));
    expect(repo.totalSpendCents()).toBe(16);
  });

  it("findImportByContentHash is the idempotency key", () => {
    const repo = new InMemoryRepository();
    expect(repo.findImportByContentHash("abc")).toBeNull();
    repo.saveImport({
      id: "imp1",
      receivedAt: "2026-01-01T00:00:00.000Z",
      sourceRef: "slack:F1",
      contentHash: "abc",
      rowCount: 40,
      nWithIdea: 16,
      nBlank: 24,
      nDone: 0,
    });
    expect(repo.findImportByContentHash("abc")?.id).toBe("imp1");
  });

  it("getLatestReviewPostForRequest returns the newest by createdAt then id, filtered by kind", () => {
    const repo = new InMemoryRepository();
    repo.saveReviewPost(
      mkReviewPost("rp1", {
        kind: "draft",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    repo.saveReviewPost(
      mkReviewPost("rp2", {
        kind: "draft",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    repo.saveReviewPost(
      mkReviewPost("rp3", {
        kind: "finals",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    );

    expect(repo.getLatestReviewPostForRequest("r1", "draft")?.id).toBe("rp2");
    expect(repo.getLatestReviewPostForRequest("r1", "finals")?.id).toBe("rp3");
  });
});
