import { describe, expect, it } from "vitest";

import { renderExportCsv } from "../../src/adapters/csv.js";
import { buildExportRow } from "../../src/domain/export-csv.js";
import type { Product, PublishedImage, ShotRequest } from "../../src/domain/types.js";

const product = (over: Partial<Product> = {}): Product => ({
  sku: "HG-002",
  name: "Stoneware Mug 12oz",
  category: "Ceramics",
  colorRaw: "Sage",
  colorSet: { matched: ["Sage"], unmatched: [] },
  material: "Stoneware",
  priceCents: 2800,
  photoUrl: "https://x/hg-002.jpg",
  notesRaw: "",
  updatedAt: "2026-09-06T12:00:00.000Z",
  ...over,
});

const request = (over: Partial<ShotRequest> = {}): ShotRequest => ({
  id: "r1",
  sku: "HG-002",
  ideaRevision: 1,
  status: "done",
  shotIdeaText: "morning kitchen counter, steam, warm light",
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

const published = (filename: string, sequence: number): PublishedImage => ({
  filename,
  requestId: "r1",
  sourceAttemptId: `att-${filename}`,
  sequence,
  stableUrl: `https://pipeline.test/img/${filename}`,
  publishedAt: "2026-09-06T12:00:00.000Z",
});

describe("buildExportRow", () => {
  it("a done Request with two picks carries both image URLs, comma-joined in sequence order", () => {
    const row = buildExportRow(product(), request(), [
      published("hg-002-styled-02.jpg", 2),
      published("hg-002-styled-01.jpg", 1),
    ]);
    expect(row.status).toBe("done");
    expect(row.shotIdea).toBe("morning kitchen counter, steam, warm light");
    expect(row.price).toBe("$28");
    // caller is expected to pass `published` already in sequence order (repo contract) — the
    // function itself just joins whatever it's given.
    expect(row.finalImageUrl).toBe(
      "https://pipeline.test/img/hg-002-styled-02.jpg, https://pipeline.test/img/hg-002-styled-01.jpg",
    );
  });

  it("a parked Request with one pick carries just that one URL", () => {
    const row = buildExportRow(
      product(),
      request({ status: "parked" }),
      [published("hg-002-styled-01.jpg", 1)],
    );
    expect(row.status).toBe("parked");
    expect(row.finalImageUrl).toBe("https://pipeline.test/img/hg-002-styled-01.jpg");
  });

  it("a failed Request with no picks carries an empty image URL cell", () => {
    const row = buildExportRow(product(), request({ status: "failed" }), []);
    expect(row.status).toBe("failed");
    expect(row.finalImageUrl).toBe("");
  });

  it("no Request at all (shouldn't happen post-ingest, but stays total) reports 'no request' and blank idea", () => {
    const row = buildExportRow(product(), null, []);
    expect(row.status).toBe("no request");
    expect(row.shotIdea).toBe("");
  });

  it("still-blank Shot Idea (a proposed Request never confirmed) round-trips the proposal text", () => {
    const row = buildExportRow(
      product(),
      request({ status: "proposed", shotIdeaText: "Sage Stoneware mug, on a shelf" }),
      [],
    );
    expect(row.status).toBe("awaiting idea");
    expect(row.shotIdea).toBe("Sage Stoneware mug, on a shelf");
  });
});

describe("renderExportCsv", () => {
  it("round-trips a comma and a quote inside Notes/Shot Idea through RFC4180 quoting", () => {
    const row = buildExportRow(
      product({ notesRaw: 'El: bestseller, "do this one first"' }),
      request({ shotIdeaText: 'on a "sunlit" table, steam rising' }),
      [],
    );
    const csv = renderExportCsv([row]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // header + one row
    expect(lines[0]).toBe(
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes,Status,Final Image URL",
    );
    expect(lines[1]).toContain('"on a ""sunlit"" table, steam rising"');
    expect(lines[1]).toContain('"El: bestseller, ""do this one first"""');
  });

  it("an empty row list renders just the header, trailing newline", () => {
    expect(renderExportCsv([])).toBe(
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes,Status,Final Image URL\n",
    );
  });
});
