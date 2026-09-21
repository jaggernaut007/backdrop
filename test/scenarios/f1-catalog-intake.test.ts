import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { ingestCatalog } from "../../src/app/ingest-catalog.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const CATALOG = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../data/catalog.csv",
  ),
);

/**
 * F1 — Catalog intake. Scenario names are SPEC.md verbatim.
 */
describe("F1 — Catalog intake", () => {
  let repo: InMemoryRepository;
  let slack: FakeSlackGateway;
  let clock: FakeClock;
  const deps = (): {
    repo: InMemoryRepository;
    slack: FakeSlackGateway;
    clock: FakeClock;
  } => ({
    repo,
    slack,
    clock,
  });

  beforeEach(() => {
    repo = new InMemoryRepository();
    slack = new FakeSlackGateway();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
  });

  it("A fresh Export is parsed into Products despite its quirks", async () => {
    await ingestCatalog(deps(), { csv: CATALOG, sourceRef: "F_TEST" });

    expect(repo.listProducts()).toHaveLength(40);

    // `$48` stored as cents
    expect(repo.getProduct("HG-001")?.priceCents).toBe(4800);
    expect(repo.getProduct("HG-002")?.priceCents).toBe(2800);

    // `"Cream Terracotta Sage"` becomes an ordered ColorSet of brand-palette terms
    expect(repo.getProduct("HG-018")?.colorSet).toEqual({
      matched: ["Cream", "Terracotta", "Sage"],
      unmatched: [],
    });

    // the SKUs absent from the sequence raise no error — they just don't exist
    for (const missing of ["HG-007", "HG-015", "HG-023", "HG-031", "HG-039"]) {
      expect(repo.getProduct(missing)).toBeNull();
    }
  });

  it("Re-ingesting the same Export changes nothing", async () => {
    await ingestCatalog(deps(), { csv: CATALOG, sourceRef: "F_TEST" });
    const productsAfterFirst = repo.listProducts().length;
    const requestsAfterFirst = repo.listRequestsInQueueOrder().length;

    const second = await ingestCatalog(deps(), {
      csv: CATALOG,
      sourceRef: "F_TEST",
    });

    expect(second.alreadyIngested).toBe(true);
    expect(repo.listProducts()).toHaveLength(productsAfterFirst);
    expect(repo.listRequestsInQueueOrder()).toHaveLength(requestsAfterFirst);
    expect(slack.postsOfKind("import-summary")).toHaveLength(1);
  });

  it("The import is summarised to the channel", async () => {
    await ingestCatalog(deps(), { csv: CATALOG, sourceRef: "F_TEST" });

    const summaries = slack.postsOfKind("import-summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.text).toContain(
      "40 products received, 16 with a Shot Idea, 24 blank, 0 done",
    );
  });

  it("A Notes priority moves a Request up the queue", async () => {
    const csv = [
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes",
      'HG-100,Plain Mug,Ceramics,Sage,Stoneware,$20,https://x/hg-100.jpg,"a plain shelf",',
      'HG-101,Bestseller Vase,Ceramics,Terracotta,Stoneware,$40,https://x/hg-101.jpg,"a windowsill","El: bestseller, do this one first"',
    ].join("\n");

    await ingestCatalog(deps(), { csv, sourceRef: "F_TEST" });

    const queue = repo.listRequestsInQueueOrder();
    expect(queue.map((r) => r.sku)).toEqual(["HG-101", "HG-100"]);
    expect(queue[0]?.priorityRank).toBeGreaterThan(queue[1]?.priorityRank ?? 0);
  });

  // --- DOMAIN.md idempotency beyond SPEC scenario 2 (which only re-drops the identical file
  //     and short-circuits on the content hash — the row loop never runs) ---

  const ONE_ROW = (idea: string, price = "$28", notes = ""): string =>
    [
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes",
      `HG-002,Stoneware Mug 12oz,Ceramics,Sage,Stoneware,${price},https://x/hg-002.jpg,"${idea}",${notes}`,
    ].join("\n");

  it("A different Export re-listing a known SKU with the same Shot Idea opens no second Request", async () => {
    await ingestCatalog(deps(), {
      csv: ONE_ROW("morning kitchen counter"),
      sourceRef: "drop-1",
    });
    expect(repo.listRequestsForSku("HG-002")).toHaveLength(1);

    // same SKU + same idea, different bytes (price bump) -> new hash -> the per-SKU guard runs
    const res = await ingestCatalog(deps(), {
      csv: ONE_ROW("morning kitchen counter", "$30"),
      sourceRef: "drop-2",
    });

    expect(res.alreadyIngested).toBe(false);
    expect(res.requestsOpened).toBe(0);
    expect(repo.listRequestsForSku("HG-002")).toHaveLength(1);
    expect(repo.getProduct("HG-002")?.priceCents).toBe(3000); // product facts still updated in place
  });

  it("A rejected (parked) SKU is re-opened as a new revision on the next drop (next-batch assumption)", async () => {
    await ingestCatalog(deps(), {
      csv: ONE_ROW("morning kitchen counter"),
      sourceRef: "drop-1",
    });
    const prior = repo.listRequestsForSku("HG-002")[0];
    repo.saveRequest({ ...prior!, status: "parked" });

    const res = await ingestCatalog(deps(), {
      csv: ONE_ROW("morning kitchen counter", "$30"),
      sourceRef: "drop-2",
    });

    expect(res.requestsOpened).toBe(1);
    const all = repo.listRequestsForSku("HG-002");
    expect(all).toHaveLength(2);
    expect(all[1]?.ideaRevision).toBe(2);
    expect(all[1]?.status).toBe("confirmed");
    expect(all[1]?.shotIdeaText).toBe("morning kitchen counter");
  });

  it("A re-import with changed Shot Idea text on a known SKU is flagged, opens nothing, and is named in the summary", async () => {
    await ingestCatalog(deps(), {
      csv: ONE_ROW("morning kitchen counter"),
      sourceRef: "drop-1",
    });

    const res = await ingestCatalog(deps(), {
      csv: ONE_ROW("on a shelf at dusk, single light source"),
      sourceRef: "drop-2",
    });

    expect(res.requestsOpened).toBe(0);
    expect(res.newIdeaRevisionSkus).toEqual(["HG-002"]);
    expect(repo.listRequestsForSku("HG-002")).toHaveLength(1); // no superseding Request (B2 cut)
    expect(repo.getActiveRequestForSku("HG-002")?.shotIdeaText).toBe(
      "morning kitchen counter",
    );

    const summary = slack.postsOfKind("import-summary").at(-1)?.text ?? "";
    expect(summary).toContain("HG-002");
    expect(summary).toContain("no new Request opened");
  });

  it("The summary counts SKUs already Done in our system, not a CSV column", async () => {
    await ingestCatalog(deps(), {
      csv: ONE_ROW("morning kitchen counter"),
      sourceRef: "drop-1",
    });
    const req = repo.getActiveRequestForSku("HG-002");
    repo.saveRequest({ ...req!, status: "done" });

    const res = await ingestCatalog(deps(), {
      csv: ONE_ROW("morning kitchen counter", "$32"),
      sourceRef: "drop-2",
    });

    expect(res.nDone).toBe(1);
    expect(slack.postsOfKind("import-summary").at(-1)?.text).toContain(
      "1 done",
    );
  });

  it("A failed summary post does not fail the ingest — durable state is still committed", async () => {
    const failingSlack = {
      postImportSummary: () => Promise.reject(new Error("slack down")),
    } as unknown as FakeSlackGateway;

    const res = await ingestCatalog(
      { repo, slack: failingSlack, clock },
      { csv: CATALOG, sourceRef: "F_TEST" },
    );

    expect(res.alreadyIngested).toBe(false);
    expect(res.summaryPosted).toBe(false);
    expect(repo.listProducts()).toHaveLength(40);
    // the hash is recorded, so a re-drop of the identical file now no-ops
    const again = await ingestCatalog(deps(), {
      csv: CATALOG,
      sourceRef: "F_TEST",
    });
    expect(again.alreadyIngested).toBe(true);
  });
});
