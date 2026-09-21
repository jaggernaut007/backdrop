import { describe, expect, it } from "vitest";

import { toColorSet } from "../../src/domain/colorset.js";
import { composeShotIdeaProposal } from "../../src/domain/shot-idea-proposal.js";
import type { Product } from "../../src/domain/types.js";

function product(over: Partial<Product> = {}): Product {
  return {
    sku: "HG-014",
    name: "Sage Linen Napkins (Set of 4)",
    category: "Napkins",
    colorRaw: "Sage",
    colorSet: toColorSet("Sage"),
    material: "Linen",
    priceCents: 2400,
    photoUrl: "https://catalog.test/assets/hg-014.jpg",
    notesRaw: "",
    updatedAt: "2026-09-06T12:00:00.000Z",
    ...over,
  };
}

describe("composeShotIdeaProposal", () => {
  it("is built from the category, ColorSet, and material", () => {
    const proposal = composeShotIdeaProposal(product());
    expect(proposal).toContain("Sage");
    expect(proposal).toContain("Linen");
    expect(proposal).toContain("Napkins");
  });

  it("includes un-branded ColorSet descriptors alongside matched palette terms", () => {
    const proposal = composeShotIdeaProposal(
      product({ colorSet: toColorSet("Charcoal Lids") }),
    );
    expect(proposal).toContain("Charcoal");
    expect(proposal).toContain("Lids");
  });

  it("omits an empty ColorSet without leaving a dangling separator", () => {
    const proposal = composeShotIdeaProposal(
      product({ colorSet: { matched: [], unmatched: [] } }),
    );
    expect(proposal).toContain("Linen");
    expect(proposal).toContain("Napkins");
    expect(proposal).not.toMatch(/^\s|,\s*,/);
  });

  it("falls back to the product name when category, material, and ColorSet are all empty", () => {
    const proposal = composeShotIdeaProposal(
      product({
        name: "Mystery Item",
        category: "",
        material: "",
        colorSet: { matched: [], unmatched: [] },
      }),
    );
    expect(proposal).toContain("Mystery Item");
  });

  it("is deterministic — same Product, same proposal", () => {
    const p = product();
    expect(composeShotIdeaProposal(p)).toBe(composeShotIdeaProposal(p));
  });
});
