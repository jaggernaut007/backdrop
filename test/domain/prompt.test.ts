import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { toColorSet } from "../../src/domain/colorset.js";
import {
  composeGenerationPrompt,
  MAX_PROMPT_CHARS,
} from "../../src/domain/prompt.js";

const base = {
  shotIdea: "morning kitchen counter, steam, warm light",
  category: "Ceramics",
  material: "Stoneware",
  colorSet: toColorSet("Sage"),
  riskFlags: [] as string[],
};

describe("composeGenerationPrompt", () => {
  it("is not a copy of the Shot Idea — it carries the product facts and palette too", () => {
    const prompt = composeGenerationPrompt(base);
    expect(prompt).toContain("morning kitchen counter, steam, warm light");
    expect(prompt).toContain("Ceramics");
    expect(prompt).toContain("Stoneware");
    expect(prompt).toContain("Sage");
    expect(prompt).not.toBe(base.shotIdea);
  });

  it("enters each generationRisk flag verbatim as a caution", () => {
    const prompt = composeGenerationPrompt({
      ...base,
      riskFlags: [
        "smoke glass photographs badly, careful",
        "too shiny under warm light",
      ],
    });
    expect(prompt).toContain(
      "Caution: smoke glass photographs badly, careful.",
    );
    expect(prompt).toContain("Caution: too shiny under warm light.");
  });

  it("names the unmatched ColorSet tones without asserting they are brand colours", () => {
    const prompt = composeGenerationPrompt({
      ...base,
      colorSet: toColorSet("Charcoal Lids"),
    });
    expect(prompt).toContain("Hold the brand palette: Charcoal.");
    expect(prompt).toContain("Other described tones: Lids.");
  });

  it("carries the reject reason forward on a retry", () => {
    const first = composeGenerationPrompt(base);
    const retry = composeGenerationPrompt({
      ...base,
      retryReason: "color off",
    });
    expect(first).not.toContain("second attempt");
    expect(retry).toContain('rejected as "color off"');
  });

  it("omits empty sections rather than emitting blank fragments", () => {
    const prompt = composeGenerationPrompt({
      ...base,
      category: "",
      material: "",
      colorSet: toColorSet("Natural Wood"), // all unmatched
    });
    expect(prompt).not.toContain("Product: ");
    expect(prompt).not.toContain("Hold the brand palette:");
    expect(prompt).toContain("Other described tones: Natural, Wood.");
  });

  it("skips a risk flag that is only whitespace", () => {
    const prompt = composeGenerationPrompt({
      ...base,
      riskFlags: ["   ", "\t\n"],
    });
    expect(prompt).not.toContain("Caution:");
  });

  it("throws when the composed prompt would exceed Luma's 6000-char limit", () => {
    expect(() =>
      composeGenerationPrompt({
        ...base,
        shotIdea: "x".repeat(MAX_PROMPT_CHARS),
      }),
    ).toThrow(/over the 6000-char/);
  });

  it("property: within bounds, the prompt always contains the Shot Idea and stays ≤ 6000 chars", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 400 }),
        fc.array(fc.string({ minLength: 1, maxLength: 120 }), { maxLength: 5 }),
        (shotIdea, riskFlags) => {
          const prompt = composeGenerationPrompt({
            ...base,
            shotIdea,
            riskFlags,
          });
          expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
          expect(prompt).toContain(shotIdea.replace(/\s+/g, " ").trim());
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: adversarial input either yields ≤ 6000 chars or throws — never a longer string", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 8000 }),
        fc.array(fc.string({ maxLength: 500 }), { maxLength: 200 }),
        (shotIdea, riskFlags) => {
          let out: string;
          try {
            out = composeGenerationPrompt({
              ...base,
              shotIdea: shotIdea || "x",
              riskFlags,
            });
          } catch (e) {
            expect((e as Error).message).toMatch(/over the 6000-char/);
            return;
          }
          expect(out.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
        },
      ),
      { numRuns: 400 },
    );
  });
});
