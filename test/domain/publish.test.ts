import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  publishedFilename,
  PUBLISH_SEQUENCE_MAX,
} from "../../src/domain/publish.js";

describe("publishedFilename", () => {
  it("is `<sku lower>-styled-NN.jpg` with a zero-padded two-digit sequence (ADR 0008 / SPEC F4)", () => {
    expect(publishedFilename("HG-002", 1)).toBe("hg-002-styled-01.jpg");
    expect(publishedFilename("HG-002", 2)).toBe("hg-002-styled-02.jpg");
    expect(publishedFilename("hg-002", 3)).toBe("hg-002-styled-03.jpg");
    expect(publishedFilename("HG-100", 10)).toBe("hg-100-styled-10.jpg");
  });

  it("lower-cases the SKU so the name is a pure function of SKU + pick order", () => {
    expect(publishedFilename("Hg-041", 1)).toBe("hg-041-styled-01.jpg");
  });

  it("rejects a non-positive, fractional, or out-of-range sequence", () => {
    expect(() => publishedFilename("HG-002", 0)).toThrow();
    expect(() => publishedFilename("HG-002", -1)).toThrow();
    expect(() => publishedFilename("HG-002", 1.5)).toThrow();
    expect(() =>
      publishedFilename("HG-002", PUBLISH_SEQUENCE_MAX + 1),
    ).toThrow();
  });

  it("rejects a SKU with no alphanumeric characters", () => {
    expect(() => publishedFilename("", 1)).toThrow();
    expect(() => publishedFilename("   ", 1)).toThrow();
    expect(() => publishedFilename("--!--", 1)).toThrow();
  });

  it("collapses non-alphanumerics to a single hyphen so the name is a safe path segment", () => {
    expect(publishedFilename("HG 002", 1)).toBe("hg-002-styled-01.jpg");
    expect(publishedFilename("hg__002", 1)).toBe("hg-002-styled-01.jpg");
    expect(publishedFilename("../HG-002", 1)).toBe("hg-002-styled-01.jpg");
    expect(publishedFilename("HG-002!!", 2)).toBe("hg-002-styled-02.jpg");
  });

  it("property: every valid call yields a greppable, collision-free `-styled-NN.jpg` name", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((s) => /[a-z0-9]/i.test(s)),
        fc.integer({ min: 1, max: PUBLISH_SEQUENCE_MAX }),
        (sku, seq) => {
          const name = publishedFilename(sku, seq);
          expect(name).toMatch(/^.+-styled-\d{2}\.jpg$/);
          expect(name).toBe(name.toLowerCase());
          // deterministic: same inputs, same output
          expect(publishedFilename(sku, seq)).toBe(name);
          // distinct pick order ⇒ distinct name for one SKU
          if (seq < PUBLISH_SEQUENCE_MAX) {
            expect(publishedFilename(sku, seq + 1)).not.toBe(name);
          }
        },
      ),
    );
  });

  it("property: the slug is /^[a-z0-9]+(-[a-z0-9]+)*$/ — no leaked chars, no leading/trailing/double hyphen", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => /[a-z0-9]/i.test(s)),
        fc.integer({ min: 1, max: PUBLISH_SEQUENCE_MAX }),
        (sku, seq) => {
          const slug = publishedFilename(sku, seq).replace(
            /-styled-\d{2}\.jpg$/,
            "",
          );
          expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
          expect(slug.includes("--")).toBe(false);
        },
      ),
    );
  });

  it("property: a SKU made only of separators always throws, whatever the mix", () => {
    const seps = fc
      .array(
        fc.constantFrom("-", "_", ".", "/", " ", "!", "@", "#", "*", "(", ")"),
        { minLength: 1, maxLength: 12 },
      )
      .map((xs) => xs.join(""));
    fc.assert(
      fc.property(seps, (sku) => {
        expect(() => publishedFilename(sku, 1)).toThrow(/no alphanumeric/);
      }),
    );
  });
});
