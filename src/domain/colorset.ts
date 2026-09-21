/**
 * `Color / Finish` cell → `ColorSet` value object. Thin wrapper over `resolvePaletteTokens`
 * (`palette.ts` owns the 10-term brand allow-list and the greedy multi-word match); this module is
 * the seam the rest of the system depends on so `ColorSet` construction has one name.
 */
import { resolvePaletteTokens } from "./palette.js";
import type { ColorSet } from "./types.js";

/**
 * `"Cream Terracotta Sage"` → `{ matched: [Cream, Terracotta, Sage], unmatched: [] }`.
 * `"Charcoal Lids"`         → `{ matched: [Charcoal], unmatched: ["Lids"] }`.
 * Source order is preserved; un-branded descriptors are kept in `unmatched`, never dropped, so the
 * GenerationPrompt can still mention them without asserting they are brand colours.
 */
export function toColorSet(raw: string): ColorSet {
  const { matched, unmatched } = resolvePaletteTokens(raw);
  return { matched, unmatched };
}
