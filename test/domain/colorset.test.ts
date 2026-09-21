import { describe, expect, it } from "vitest";

import { toColorSet } from "../../src/domain/colorset.js";

/**
 * `toColorSet` is a thin VO wrapper — `resolvePaletteTokens` is exhaustively covered in
 * palette.test.ts. These lock the wrapper's shape and the F1 quirks it must survive.
 */
describe("toColorSet", () => {
  it("resolves an ordered multi-term ColorSet (SPEC F1)", () => {
    expect(toColorSet("Cream Terracotta Sage")).toEqual({
      matched: ["Cream", "Terracotta", "Sage"],
      unmatched: [],
    });
  });

  it("keeps un-branded descriptors as unmatched, never dropped", () => {
    expect(toColorSet("Charcoal Lids")).toEqual({
      matched: ["Charcoal"],
      unmatched: ["Lids"],
    });
    expect(toColorSet("Natural Wood")).toEqual({
      matched: [],
      unmatched: ["Natural", "Wood"],
    });
  });

  it("greedily matches multi-word palette terms", () => {
    expect(toColorSet("Clay Pink Charcoal")).toEqual({
      matched: ["Clay Pink", "Charcoal"],
      unmatched: [],
    });
  });

  it("is empty for an empty cell", () => {
    expect(toColorSet("")).toEqual({ matched: [], unmatched: [] });
  });
});
