/**
 * The one Slack message an import produces (SPEC F1: "The import is summarised to the channel").
 * Pure string composition — the use-case counts, this renders. The base line is asserted verbatim
 * by the spec, so it is a fixed template, not a format string a caller can vary.
 */

export interface ImportCounts {
  /** Rows that became Products (blank-SKU / separator rows already dropped). */
  readonly rowCount: number;
  /** Rows carrying a Shot Idea. */
  readonly nWithIdea: number;
  /** Rows with an empty Shot Idea column — F2 handles these later. */
  readonly nBlank: number;
  /** SKUs already Done. Always 0 on input: the Export carries no status column (DOMAIN.md). */
  readonly nDone: number;
}

/**
 * `{ rowCount: 40, nWithIdea: 16, nBlank: 24, nDone: 0 }` →
 *   `"40 products received, 16 with a Shot Idea, 24 blank, 0 done"`
 *
 * If a re-import carried changed Shot Idea text for a known SKU, those SKUs are named on a second
 * line (`NewIdeaRevisionDetected` — no superseding Request is opened; a human decides. DOMAIN.md /
 * ASSUMPTIONS.md B2).
 */
export function renderImportSummary(
  counts: ImportCounts,
  newIdeaRevisionSkus: readonly string[] = [],
): string {
  const base = `${counts.rowCount} products received, ${counts.nWithIdea} with a Shot Idea, ${counts.nBlank} blank, ${counts.nDone} done`;
  if (newIdeaRevisionSkus.length === 0) return base;
  return `${base}\nShot Idea changed since a prior import for ${newIdeaRevisionSkus.join(", ")} — no new Request opened; a human decides.`;
}
