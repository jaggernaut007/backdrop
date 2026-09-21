import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { interpretNotes } from "../../src/domain/notes.js";

const EMPTY = {
  priority: false,
  generationRisk: [],
  sourceAssetQuality: null,
  lifecycleConcern: null,
  bundlingIntent: null,
};

describe("interpretNotes — real catalog Notes values (ADR 0010 / ASSUMPTIONS.md A4)", () => {
  it("an empty Notes column classifies to nothing", () => {
    expect(interpretNotes("")).toEqual(EMPTY);
  });

  it.each([
    "El: bestseller, do this one first",
    "top seller, gets reordered constantly",
    "stocking stuffer push",
  ])("priority is detected: %j", (raw) => {
    expect(interpretNotes(raw).priority).toBe(true);
  });

  it.each([
    "gift set, big for Q4 last yr",
    "plant not included lol",
    "holiday table story?",
  ])("no false-positive priority: %j", (raw) => {
    expect(interpretNotes(raw).priority).toBe(false);
  });

  it("a generation risk strips the speaker prefix and keeps the caution (SPEC F3a)", () => {
    expect(
      interpretNotes("El: smoke glass photographs badly, careful")
        .generationRisk,
    ).toEqual(["smoke glass photographs badly, careful"]);
  });

  it.each([
    "came out too shiny in last shoot",
    "pricey, needs to look premium",
  ])("a generation risk is captured: %j", (raw) => {
    expect(interpretNotes(raw).generationRisk.length).toBeGreaterThan(0);
  });

  it.each([
    "surface reads matte, watch the glare",
    "acrylic reflects the softbox badly",
  ])(
    "a generation risk is captured from matte/glare/reflect wording: %j",
    (raw) => {
      expect(interpretNotes(raw).generationRisk.length).toBeGreaterThan(0);
    },
  );

  it.each(["the escalation contact: bestseller, push this one", "the approver: careful, smoke glass"])(
    "strips a the escalation contact:/the approver: speaker prefix, not just El: — %j",
    (raw) => {
      const n = interpretNotes(raw);
      expect(n.priority || n.generationRisk.length > 0).toBe(true);
      expect(
        n.generationRisk.every((r) => !/^(maya|ellie|el)\s*:/i.test(r)),
      ).toBe(true);
    },
  );

  it("an underexposed source photo is sourceAssetQuality, not a generation risk", () => {
    const n = interpretNotes("photo slightly underexposed?");
    expect(n.sourceAssetQuality).toBe("photo slightly underexposed?");
    expect(n.generationRisk).toEqual([]);
    expect(n.priority).toBe(false);
  });

  it("a lifecycle concern is flagged only — no priority, no risk", () => {
    const n = interpretNotes("discontinued after spring?");
    expect(n.lifecycleConcern).toBe("discontinued after spring?");
    expect(n.priority).toBe(false);
    expect(n.generationRisk).toEqual([]);
  });

  it.each([
    ["El: shoot with the mugs maybe", "shoot with the mugs maybe"],
    ["bathroom set w/ the towels?", "bathroom set w/ the towels?"],
  ])("a bundling intent is flagged only: %j", (raw, expected) => {
    const n = interpretNotes(raw);
    expect(n.bundlingIntent).toBe(expected);
    expect(n.priority).toBe(false);
    expect(n.generationRisk).toEqual([]);
  });
});

describe("interpretNotes — invariants (property)", () => {
  it("never throws and always returns a complete interpretation", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const n = interpretNotes(s);
        expect(typeof n.priority).toBe("boolean");
        expect(Array.isArray(n.generationRisk)).toBe(true);
        expect(
          n.sourceAssetQuality === null ||
            typeof n.sourceAssetQuality === "string",
        ).toBe(true);
        expect(
          n.lifecycleConcern === null || typeof n.lifecycleConcern === "string",
        ).toBe(true);
        expect(
          n.bundlingIntent === null || typeof n.bundlingIntent === "string",
        ).toBe(true);
      }),
    );
  });

  it("lifecycle / bundling / junk notes never influence the pipeline (no priority, no risk)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "discontinued after spring?",
          "shoot with the mugs maybe",
          "plant not included lol",
          "gift set, big for Q4 last yr",
        ),
        (raw) => {
          const n = interpretNotes(raw);
          expect(n.priority).toBe(false);
          expect(n.generationRisk).toEqual([]);
        },
      ),
    );
  });
});
