/**
 * The brand's tight, repeating colour palette — the same ~10 terms recur across every
 * category in `data/catalog.csv` (TASK.md "Data handoff — observed quirks").
 *
 * Brand consistency is checkable, not vibes: a `Color / Finish` cell like
 * "Cream Terracotta Sage" is an *ordered* list of these terms plus, sometimes, an
 * un-branded descriptor ("Natural", "Wood", "Lids", "Stem", "Tint", "Liner", "Green").
 * The palette is the allow-list; anything else is kept as an `unmatched` token so the
 * GenerationPrompt can still mention it without pretending it's a brand colour.
 */
export const BRAND_PALETTE = [
  "Terracotta",
  "Sage",
  "Ochre",
  "Dusty Blue",
  "Clay Pink",
  "Charcoal",
  "Cream",
  "Forest",
  "Amber",
  "Smoke",
] as const;

export type BrandColor = (typeof BRAND_PALETTE)[number];

/** Lower-cased lookup: single-word palette terms → canonical casing. */
const SINGLE_WORD_LOOKUP: ReadonlyMap<string, BrandColor> = new Map(
  BRAND_PALETTE.filter((term) => !term.includes(" ")).map((term) => [
    term.toLowerCase(),
    term,
  ]),
);

/** Multi-word palette terms ("Dusty Blue", "Clay Pink"), longest first for greedy matching. */
const MULTI_WORD_TERMS: readonly BrandColor[] = BRAND_PALETTE.filter((term) =>
  term.includes(" "),
).sort((a, b) => b.split(" ").length - a.split(" ").length);

/**
 * Resolve a whitespace-tokenised `Color / Finish` value into an ordered list of
 * palette hits and unmatched descriptors, preserving source order.
 *
 * "Cream Terracotta Sage"      -> [Cream, Terracotta, Sage]
 * "Clay Pink Charcoal"         -> [Clay Pink, Charcoal]
 * "Natural Wood"               -> [] matched, ["Natural", "Wood"] unmatched
 * "Charcoal Lids"              -> [Charcoal] matched, ["Lids"] unmatched
 */
export function resolvePaletteTokens(raw: string): {
  matched: BrandColor[];
  unmatched: string[];
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const matched: BrandColor[] = [];
  const unmatched: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    // Greedy: try to consume a multi-word palette term starting here.
    const multi = MULTI_WORD_TERMS.find((term) => {
      const parts = term.toLowerCase().split(" ");
      return parts.every(
        (part, offset) => tokens[i + offset]?.toLowerCase() === part,
      );
    });
    if (multi) {
      matched.push(multi);
      i += multi.split(" ").length - 1;
      continue;
    }

    const single = SINGLE_WORD_LOOKUP.get(token.toLowerCase());
    if (single) {
      matched.push(single);
    } else {
      unmatched.push(token);
    }
  }

  return { matched, unmatched };
}
