import { afterEach, describe, expect, it } from "vitest";

import { SqliteRepository } from "../../src/adapters/sqlite-repository.js";

/**
 * Storage-specific behaviour of the SQLite adapter. The full port contract is exercised against
 * both this and InMemoryRepository in test/contracts/repository.contract.test.ts.
 */
describe("SqliteRepository — storage specifics", () => {
  let repo: SqliteRepository;
  afterEach(() => repo.close());

  const migrated = (): SqliteRepository => {
    repo = new SqliteRepository(":memory:");
    repo.migrate();
    return repo;
  };

  it("migrate() is idempotent", () => {
    const r = migrated();
    expect(() => r.migrate()).not.toThrow();
  });

  // Regression (prod crash-loop, Wave 8 deploy): SCHEMA once re-created the narrow
  // UNIQUE(slack_channel, slack_ts) index that WIDEN_REVIEW_POSTS_INDEX had dropped. With a draft
  // and a finals row legitimately sharing one (channel, ts), the next boot's migrate() threw
  // UNIQUE constraint failed. The second migrate() here replays that redeploy boot.
  it("migrate() survives draft + finals review posts sharing one (channel, ts)", () => {
    const r = migrated();
    const base = {
      requestId: "req-1",
      attemptId: "att-1",
      slackChannel: "C123",
      slackTs: "1700000000.000001",
      createdAt: "2026-09-06T12:00:00.000Z",
    };
    r.saveReviewPost({ ...base, id: "rp-draft", kind: "draft" });
    r.saveReviewPost({ ...base, id: "rp-finals", kind: "finals" });
    expect(() => r.migrate()).not.toThrow();
  });

  it("round-trips a ColorSet through its JSON column", () => {
    const r = migrated();
    r.upsertProduct({
      sku: "HG-018",
      name: "Canister Set (3)",
      category: "Kitchen",
      colorRaw: "Cream Terracotta Sage",
      colorSet: { matched: ["Cream", "Terracotta", "Sage"], unmatched: [] },
      material: "Stoneware",
      priceCents: 6400,
      photoUrl: "https://x/hg-018.jpg",
      notesRaw: "",
      updatedAt: "2026-09-06T12:00:00.000Z",
    });
    expect(r.getProduct("HG-018")?.colorSet).toEqual({
      matched: ["Cream", "Terracotta", "Sage"],
      unmatched: [],
    });
  });

  it("upsertProduct is last-writer-wins on SKU", () => {
    const r = migrated();
    const base = {
      sku: "HG-001",
      name: "Vase",
      category: "Ceramics",
      colorRaw: "Terracotta",
      colorSet: { matched: ["Terracotta" as const], unmatched: [] },
      material: "Stoneware",
      priceCents: 4800,
      photoUrl: "https://x/1.jpg",
      notesRaw: "",
      updatedAt: "2026-09-06T12:00:00.000Z",
    };
    r.upsertProduct(base);
    r.upsertProduct({
      ...base,
      priceCents: 5000,
      photoUrl: "https://x/1b.jpg",
    });
    expect(r.getProduct("HG-001")?.priceCents).toBe(5000);
    expect(r.getProduct("HG-001")?.photoUrl).toBe("https://x/1b.jpg");
    expect(r.listProducts()).toHaveLength(1);
  });

  it("preserves boolean and nullable columns on a ShotRequest round-trip", () => {
    const r = migrated();
    r.saveRequest({
      id: "req-1",
      sku: "HG-041",
      ideaRevision: 1,
      status: "confirmed",
      shotIdeaText: "iced drinks on a patio table",
      shotIdeaOrigin: "sheet",
      priorityRank: 0,
      riskFlags: ["smoke glass photographs badly, careful"],
      lifecycleFlag: null,
      bundlingFlag: null,
      retryUsed: true,
      createdAt: "2026-09-06T12:00:00.000Z",
      draftPostedAt: null,
      escalatedAt: null,
    });
    const back = r.getRequest("req-1");
    expect(back?.retryUsed).toBe(true);
    expect(back?.riskFlags).toEqual(["smoke glass photographs badly, careful"]);
    expect(back?.lifecycleFlag).toBeNull();
    expect(back?.draftPostedAt).toBeNull();
  });
});
