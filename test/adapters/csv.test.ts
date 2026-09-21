import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCatalogCsv } from "../../src/adapters/csv.js";

const CATALOG = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/catalog.sample.csv",
  ),
);

describe("parseCatalogCsv — the real Export", () => {
  const rows = parseCatalogCsv(CATALOG);

  it("maps the awkward headers and yields one row per SKU", () => {
    expect(rows).toHaveLength(40);
    expect(rows[0]?.sku).toBe("HG-001");
    expect(rows[0]?.productName).toBe("Speckled Vase");
    expect(rows[0]?.colorFinish).toBe("Terracotta"); // header is "Color / Finish"
  });

  it("keeps interior commas in a quoted Shot Idea / Notes", () => {
    const hg002 = rows.find((r) => r.sku === "HG-002");
    expect(hg002?.shotIdea).toBe("morning table by a window, steam, soft light");
    expect(hg002?.notes).toBe("bestseller, shoot this one first");
  });

  it("leaves the leading $ on the price for the domain layer", () => {
    expect(rows.find((r) => r.sku === "HG-001")?.price).toBe("$48");
  });

  it("returns empty strings for a blank Shot Idea and blank Notes", () => {
    const hg001 = rows.find((r) => r.sku === "HG-001");
    expect(hg001?.shotIdea).toBe("");
    expect(hg001?.notes).toBe("");
  });

  it("accepts a string as well as a Buffer", () => {
    expect(parseCatalogCsv(CATALOG.toString("utf8"))).toHaveLength(40);
  });

  it("drops a separator / blank-SKU row instead of emitting an empty Product", () => {
    const csv = [
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes",
      "HG-001,Vase,Ceramics,Terracotta,Stoneware,$48,https://x/1.jpg,,",
      ",,,,,,,,",
      "HG-002,Mug,Ceramics,Sage,Stoneware,$28,https://x/2.jpg,,",
    ].join("\n");
    expect(parseCatalogCsv(csv).map((r) => r.sku)).toEqual([
      "HG-001",
      "HG-002",
    ]);
  });

  it("tolerates a short trailing row (relax_column_count) — missing cells come back empty", () => {
    const csv = [
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes",
      "HG-001,Vase,Ceramics,Terracotta,Stoneware,$48",
    ].join("\n");
    const rows = parseCatalogCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.photo).toBe("");
    expect(rows[0]?.notes).toBe("");
  });

  it("throws — not silently drops every row — when an expected header is missing", () => {
    const csv = [
      "Item,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes",
      "HG-001,Vase,Ceramics,Terracotta,Stoneware,$48,https://x/1.jpg,,",
    ].join("\n");
    expect(() => parseCatalogCsv(csv)).toThrow(/missing expected column/i);
  });
});
