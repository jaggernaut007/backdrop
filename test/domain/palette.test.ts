import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BRAND_PALETTE,
  resolvePaletteTokens,
} from "../../src/domain/palette.js";

describe("resolvePaletteTokens — real catalog `Color / Finish` shapes", () => {
  it.each<[string, { matched: string[]; unmatched: string[] }]>([
    // single palette term alone — the dominant shape in test/fixtures/catalog.sample.csv
    ["Terracotta", { matched: ["Terracotta"], unmatched: [] }],
    ["Smoke", { matched: ["Smoke"], unmatched: [] }],
    ["Dusty Blue", { matched: ["Dusty Blue"], unmatched: [] }],
    ["Clay Pink", { matched: ["Clay Pink"], unmatched: [] }],
    // SPEC F1 verbatim
    [
      "Cream Terracotta Sage",
      { matched: ["Cream", "Terracotta", "Sage"], unmatched: [] },
    ],
    [
      "Clay Pink Charcoal",
      { matched: ["Clay Pink", "Charcoal"], unmatched: [] },
    ],
    // palette term + un-branded descriptor
    ["Sage Cream", { matched: ["Sage", "Cream"], unmatched: [] }],
    ["Sage Stem", { matched: ["Sage"], unmatched: ["Stem"] }],
    ["Sage Liner", { matched: ["Sage"], unmatched: ["Liner"] }],
    ["Cream Wood", { matched: ["Cream"], unmatched: ["Wood"] }],
    ["Charcoal Lids", { matched: ["Charcoal"], unmatched: ["Lids"] }],
    ["Natural Wood", { matched: [], unmatched: ["Natural", "Wood"] }],
    ["Green Tint", { matched: [], unmatched: ["Green", "Tint"] }],
    // bare "Clay" is NOT a palette term — only "Clay Pink" is — so it must fall to unmatched
    [
      "Ochre Clay Terracotta",
      { matched: ["Ochre", "Terracotta"], unmatched: ["Clay"] },
    ],
    ["Cream Clay Sage", { matched: ["Cream", "Sage"], unmatched: ["Clay"] }],
  ])("%j", (raw, expected) => {
    expect(resolvePaletteTokens(raw)).toEqual(expected);
  });

  it.each(["", "   ", "\t\n"])("degenerate input %j → empty sets", (raw) => {
    expect(resolvePaletteTokens(raw)).toEqual({ matched: [], unmatched: [] });
  });

  it("is insensitive to surrounding and doubled whitespace", () => {
    expect(resolvePaletteTokens("  Cream   Terracotta  ")).toEqual({
      matched: ["Cream", "Terracotta"],
      unmatched: [],
    });
  });

  it("is case-insensitive and returns canonical casing", () => {
    expect(resolvePaletteTokens("cream terracotta sage")).toEqual({
      matched: ["Cream", "Terracotta", "Sage"],
      unmatched: [],
    });
    expect(resolvePaletteTokens("DUSTY BLUE")).toEqual({
      matched: ["Dusty Blue"],
      unmatched: [],
    });
  });
});

describe("resolvePaletteTokens — DOMAIN.md ColorSet invariants (property)", () => {
  const SINGLE = BRAND_PALETTE.filter((t) => !t.includes(" "));
  const NOISE = [
    "Natural",
    "Wood",
    "Lids",
    "Stem",
    "Tint",
    "Liner",
    "Green",
    "Clay",
    "Matte",
  ];
  const anyToken = fc.constantFrom<string>(...BRAND_PALETTE, ...NOISE);

  it("classifies every source token exactly once (conservation)", () => {
    fc.assert(
      fc.property(fc.array(anyToken), (parts) => {
        const raw = parts.join(" ");
        const { matched, unmatched } = resolvePaletteTokens(raw);
        const consumed =
          matched.reduce((n, t) => n + t.split(" ").length, 0) +
          unmatched.length;
        const nTokens = raw.trim() ? raw.trim().split(/\s+/).length : 0;
        expect(consumed).toBe(nTokens);
      }),
    );
  });

  it("preserves order for all-palette single-word input, with empty unmatched", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<string>(...SINGLE)), (parts) => {
        const { matched, unmatched } = resolvePaletteTokens(parts.join(" "));
        expect(matched).toEqual(parts);
        expect(unmatched).toEqual([]);
      }),
    );
  });

  it("only ever emits allow-listed terms in matched", () => {
    fc.assert(
      fc.property(fc.array(anyToken), (parts) => {
        const { matched } = resolvePaletteTokens(parts.join(" "));
        expect(
          matched.every((t) =>
            (BRAND_PALETTE as readonly string[]).includes(t),
          ),
        ).toBe(true);
      }),
    );
  });

  it("never leaves a single-word palette term in unmatched", () => {
    const singles = SINGLE.map((t) => t.toLowerCase());
    fc.assert(
      fc.property(fc.array(anyToken), (parts) => {
        const { unmatched } = resolvePaletteTokens(parts.join(" "));
        expect(unmatched.some((u) => singles.includes(u.toLowerCase()))).toBe(
          false,
        );
      }),
    );
  });

  it("full result is invariant under extra whitespace (casing preserved)", () => {
    fc.assert(
      fc.property(fc.array(anyToken), (parts) => {
        const raw = parts.join(" ");
        expect(resolvePaletteTokens(raw)).toEqual(
          resolvePaletteTokens(`   ${raw.replace(/ /g, "   ")}   `),
        );
      }),
    );
  });

  it("the matched palette terms are invariant under input case (unmatched echo source case)", () => {
    fc.assert(
      fc.property(fc.array(anyToken), (parts) => {
        const raw = parts.join(" ");
        expect(resolvePaletteTokens(raw).matched).toEqual(
          resolvePaletteTokens(raw.toLowerCase()).matched,
        );
      }),
    );
  });
});
