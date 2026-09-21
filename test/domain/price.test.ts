import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatPriceCents, parsePriceCents } from "../../src/domain/price.js";

describe("parsePriceCents", () => {
  it.each<[string, number]>([
    ["$48", 4800], // SPEC F1 verbatim
    ["$28", 2800],
    ["$120", 12000],
    ["$14", 1400],
    ["48", 4800], // tolerate a missing $
    ["$1,234", 123400], // thousands separator
    ["$12.50", 1250], // a decimal price (exact in float)
    ["$12.34", 1234], // float trap: 12.34 * 100 === 1233.9999999999998 — Math.round covers it
    ["$9.99", 999],
    ["$0.05", 5],
    ["  $18  ", 1800], // surrounding whitespace
  ])("%j -> %d cents", (raw, cents) => {
    expect(parsePriceCents(raw)).toBe(cents);
  });

  it.each([
    "",
    "   ",
    "$",
    "free",
    "$abc",
    "-$5",
    "$0x10",
    "1e3",
    "Infinity",
    "$1.2.3",
  ])("throws on a malformed price %j rather than storing NaN", (raw) => {
    expect(() => parsePriceCents(raw)).toThrow();
  });

  it("never returns a non-integer for any well-formed dollar.cents string", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 99 }),
        (dollars, cents) => {
          const out = parsePriceCents(
            `$${dollars}.${String(cents).padStart(2, "0")}`,
          );
          expect(Number.isInteger(out)).toBe(true);
          expect(out).toBe(dollars * 100 + cents);
        },
      ),
    );
  });
});

// F7 / ADR 0019 — the CSV export writes cents back out as a "$NN" string.
describe("formatPriceCents", () => {
  it.each<[number, string]>([
    [4800, "$48"], // whole dollars — no trailing .00
    [2800, "$28"],
    [1250, "$12.50"], // real cents kept
    [1234, "$12.34"],
    [999, "$9.99"],
    [5, "$0.05"],
    [0, "$0"],
  ])("%d cents -> %j", (cents, formatted) => {
    expect(formatPriceCents(cents)).toBe(formatted);
  });

  it("round-trips through parsePriceCents for any whole-dollar amount", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (dollars) => {
        const cents = dollars * 100;
        expect(parsePriceCents(formatPriceCents(cents))).toBe(cents);
      }),
    );
  });

  it("round-trips through parsePriceCents for any dollars.cents amount", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 99 }),
        (dollars, subCents) => {
          const cents = dollars * 100 + subCents;
          expect(parsePriceCents(formatPriceCents(cents))).toBe(cents);
        },
      ),
    );
  });
});
