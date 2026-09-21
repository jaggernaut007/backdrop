import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ingestCatalog } from "../../src/app/ingest-catalog.js";
import { SqliteRepository } from "../../src/adapters/sqlite-repository.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";

const CATALOG = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/catalog.sample.csv",
  ),
);

/**
 * `ingestCatalog` against the REAL `SqliteRepository` — the fake models neither the
 * `catalog_import_rows` → `catalog_imports` foreign key nor `pragma foreign_keys = ON`, so a
 * regression that writes an import row before its parent import (the Wave-7 audit's BLOCK #1) is
 * only caught here.
 */
describe("ingestCatalog + SqliteRepository (integration)", () => {
  const dbs: SqliteRepository[] = [];
  afterEach(() => {
    for (const r of dbs.splice(0)) r.close();
  });
  const makeRepo = (): SqliteRepository => {
    const r = new SqliteRepository(":memory:");
    r.migrate();
    dbs.push(r);
    return r;
  };

  it("ingests the full catalog without tripping the import-row foreign key", async () => {
    const repo = makeRepo();
    const slack = new FakeSlackGateway();
    const clock = new FakeClock("2026-09-06T12:00:00.000Z");

    const res = await ingestCatalog(
      { repo, slack, clock },
      { csv: CATALOG, sourceRef: "F_TEST" },
    );

    // every catalog row is registered against the import (FK parent written first)
    expect(res.alreadyIngested).toBe(false);
    expect(repo.listSkusForImport(res.importId)).toHaveLength(res.rowCount);
    expect(repo.listProducts()).toHaveLength(res.rowCount);
    // the batch status post landed (its row list is what needs the import rows)
    expect(repo.getBatchStatusPost(res.importId)).not.toBeNull();
    expect(repo.listOpenBatches().map((b) => b.id)).toEqual([res.importId]);
  });
});
