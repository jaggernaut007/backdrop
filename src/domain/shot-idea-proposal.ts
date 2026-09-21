/**
 * A proposed Shot Idea for a blank-row Product — co-posted with the ask (SPEC F2, ASSUMPTIONS.md
 * A5: no timer, the proposal is text posted beside the ask). Pure. Built from facts already on the
 * row — category, ColorSet, material — no Luma call, no judgment beyond assembling them.
 */
import type { Product } from "./types.js";

/**
 * `{category: "Napkins", material: "Linen", colorSet: {matched:["Sage"], unmatched:[]}}` →
 * `"Sage Linen napkins, styled on a neutral surface with soft natural light"`. Falls back to the
 * product name if category, material, and ColorSet are all empty.
 */
export function composeShotIdeaProposal(product: Product): string {
  const colorWords = [
    ...product.colorSet.matched,
    ...product.colorSet.unmatched,
  ];
  const parts = [...colorWords, product.material, product.category]
    .map((s) => s.trim())
    .filter(Boolean);
  const subject = parts.length > 0 ? parts.join(" ") : product.name.trim();
  return `${subject}, styled on a neutral surface with soft natural light`;
}
