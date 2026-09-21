/**
 * Parses the customer's catalog Export into typed rows. `csv-parse@7.0.2` sync API — see
 * docs/libraries/datastore-and-http.md §4 for the option choices and the quirks they cover
 * (quoted commas, leading `$`, empty trailing `Notes`, the `Color / Finish` header).
 *
 * This is the only place the raw CSV shape is known. Everything downstream speaks `RawCatalogRow`.
 */
import { parse } from "csv-parse/sync";

import type { ExportRow } from "../domain/export-csv.js";

export interface RawCatalogRow {
  readonly sku: string;
  readonly productName: string;
  readonly category: string;
  readonly colorFinish: string;
  readonly material: string;
  /** Left as the source string (`"$48"`); `domain/price.ts` turns it into cents. */
  readonly price: string;
  readonly photo: string;
  readonly shotIdea: string;
  readonly notes: string;
}

/** Export header → `RawCatalogRow` key. Header text is matched exactly (after csv-parse trims it). */
const HEADER_MAP: ReadonlyArray<readonly [string, keyof RawCatalogRow]> = [
  ["SKU", "sku"],
  ["Product Name", "productName"],
  ["Category", "category"],
  ["Color / Finish", "colorFinish"],
  ["Material", "material"],
  ["Price", "price"],
  ["Photo", "photo"],
  ["Shot Idea", "shotIdea"],
  ["Notes", "notes"],
];

/**
 * Parse the Export bytes into `RawCatalogRow[]`. Every declared column is present on every row
 * (a short trailing row's missing cells come back as `""`); rows with a blank `SKU` — spreadsheet
 * separator / subtotal lines — are dropped, so `rows.length` is the Product count, not the CSV
 * line count. All values are trimmed. Quoting, BOM, and short-row handling are delegated to
 * `csv-parse` per the options in docs/libraries/datastore-and-http.md §4.
 *
 * `"HG-001,Vase,…,\"El: bestseller, do this one first\""` → one row whose `notes` keeps the
 * interior comma and colon. Throws whatever `csv-parse` throws on structurally invalid CSV
 * (e.g. an unterminated quoted field).
 */
export function parseCatalogCsv(input: string | Buffer): RawCatalogRow[] {
  const records = parse(input, {
    // Validate the actual header row here — a renamed / missing header would otherwise silently
    // drop every data row (blank SKU) and post "0 products received" instead of failing. Checking
    // the header (not a data record) so a short trailing data row doesn't trip it.
    columns: (header: string[]) => {
      const missing = HEADER_MAP.map(([h]) => h).filter(
        (h) => !header.includes(h),
      );
      if (missing.length > 0) {
        throw new Error(
          `catalog CSV is missing expected column(s): ${missing.join(", ")}`,
        );
      }
      return header;
    },
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true, // tolerate a short trailing row -> missing cols come back as ''
  }) as Array<Record<string, string | undefined>>;

  const rows: RawCatalogRow[] = [];
  for (const rec of records) {
    const row: Record<keyof RawCatalogRow, string> = {
      sku: "",
      productName: "",
      category: "",
      colorFinish: "",
      material: "",
      price: "",
      photo: "",
      shotIdea: "",
      notes: "",
    };
    for (const [header, key] of HEADER_MAP) {
      row[key] = (rec[header] ?? "").trim();
    }
    if (row.sku === "") continue; // blank / separator row — not a Product
    rows.push(row);
  }
  return rows;
}

// --- write side (Wave 7 / ADR 0019, F7 batch-completion export) ------------------------------

/** The original 9 columns, plus the two new ones — exact header text for the round-tripped export. */
const EXPORT_HEADER = [
  "SKU",
  "Product Name",
  "Category",
  "Color / Finish",
  "Material",
  "Price",
  "Photo",
  "Shot Idea",
  "Notes",
  "Status",
  "Final Image URL",
];

/**
 * RFC4180-ish quoting: wrap in quotes and double any interior quote whenever the field contains a
 * comma, quote, or newline (the same three cases the read side's `csv-parse` needs quoting for).
 * No dependency needed for a fixed, 11-column shape this small.
 */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Render the batch-completion export (`ExportRow[]` → CSV text, trailing newline). */
export function renderExportCsv(rows: readonly ExportRow[]): string {
  const lines = [EXPORT_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.sku,
        r.productName,
        r.category,
        r.colorFinish,
        r.material,
        r.price,
        r.photo,
        r.shotIdea,
        r.notes,
        r.status,
        r.finalImageUrl,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
