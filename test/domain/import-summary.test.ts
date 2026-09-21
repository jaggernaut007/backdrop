import { describe, expect, it } from "vitest";

import { renderImportSummary } from "../../src/domain/import-summary.js";

describe("renderImportSummary", () => {
  it("renders the SPEC F1 line verbatim", () => {
    expect(
      renderImportSummary({
        rowCount: 40,
        nWithIdea: 16,
        nBlank: 24,
        nDone: 0,
      }),
    ).toBe("40 products received, 16 with a Shot Idea, 24 blank, 0 done");
  });

  it("names SKUs whose Shot Idea changed since a prior import, on a second line", () => {
    const out = renderImportSummary(
      { rowCount: 40, nWithIdea: 16, nBlank: 24, nDone: 0 },
      ["HG-002", "HG-011"],
    );
    expect(out).toContain(
      "40 products received, 16 with a Shot Idea, 24 blank, 0 done",
    );
    expect(out).toContain("HG-002, HG-011");
    expect(out).toContain("no new Request opened");
  });
});
