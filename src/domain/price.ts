/**
 * `Price` column → integer cents. The customer's Export writes prices as `$48`, `$120`, sometimes
 * with a decimal or a thousands separator (SPEC F1: "$48 is stored as 4800 cents"). Parsing lives
 * in the domain because "what is a valid price" is a business rule, not CSV mechanics.
 */

/**
 * `"$48"` → `4800`. Strips a leading `$`, thousands `,`, and surrounding space; rejects anything
 * that isn't a non-negative number so a malformed row fails loudly at ingest rather than storing
 * `NaN` cents.
 */
export function parsePriceCents(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  // Plain decimal only — `Number()` alone would also accept `0x10`, `1e3`, `Infinity`.
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(
      `price is not a plain non-negative amount: ${JSON.stringify(raw)}`,
    );
  }
  // Round rather than truncate — `12.34 * 100` is `1233.9999…` in float.
  return Math.round(Number(cleaned) * 100);
}

/**
 * `4800` → `"$48"`. The inverse of `parsePriceCents`, for the Wave 7 CSV export (F7 / ADR 0019) —
 * nothing before that feature needed to turn cents back into the customer's `"$NN"` shape. Drops a
 * trailing `.00` (whole dollars stay `"$48"`, not `"$48.00"`) but keeps real cents (`"$48.50"`).
 */
export function formatPriceCents(cents: number): string {
  const dollars = cents / 100;
  const fixed = dollars.toFixed(2);
  return `$${fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed}`;
}
