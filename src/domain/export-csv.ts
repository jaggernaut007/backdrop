/**
 * One row of the batch-completion CSV export (Wave 7 / ADR 0019, F7): the original 9 catalog
 * columns (blank Shot Ideas now filled in from the confirmed `ShotRequest`) plus `Status` and
 * `Final Image URL`. Pure — no Slack, no persistence; `app/export-batch-csv.ts` reads the repo and
 * calls `buildExportRow` once per SKU in the batch.
 */
import { plainStatusLabel } from "./batch-status.js";
import { formatPriceCents } from "./price.js";
import type { Product, PublishedImage, ShotRequest } from "./types.js";

export interface ExportRow {
  readonly sku: string;
  readonly productName: string;
  readonly category: string;
  readonly colorFinish: string;
  readonly material: string;
  readonly price: string;
  readonly photo: string;
  readonly shotIdea: string;
  readonly notes: string;
  readonly status: string;
  readonly finalImageUrl: string;
}

/**
 * `request` is the SKU's current (active-or-latest) Request, `null` if none exists (shouldn't
 * happen for a row that went through ingest, but kept total rather than throwing). `published` is
 * that Request's picks in `sequence` order — joined into one comma-separated cell; empty for a SKU
 * with no picks yet.
 */
export function buildExportRow(
  product: Product,
  request: ShotRequest | null,
  published: readonly PublishedImage[],
): ExportRow {
  return {
    sku: product.sku,
    productName: product.name,
    category: product.category,
    colorFinish: product.colorRaw,
    material: product.material,
    price: formatPriceCents(product.priceCents),
    photo: product.photoUrl,
    shotIdea: request?.shotIdeaText ?? "",
    notes: product.notesRaw,
    status: request ? plainStatusLabel(request.status) : "no request",
    finalImageUrl: published.map((p) => p.stableUrl).join(", "),
  };
}
