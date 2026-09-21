import { describe, expect, it } from "vitest";

import {
  friendlyStatusLabel,
  isBatchComplete,
  plainStatusLabel,
} from "../../src/domain/batch-status.js";
import type { ShotRequestStatus } from "../../src/domain/types.js";

const ALL_STATUSES: ShotRequestStatus[] = [
  "proposed",
  "confirmed",
  "drafting",
  "in_review",
  "approved",
  "finalizing",
  "picking",
  "done",
  "parked",
  "failed",
  "stale",
];

describe("friendlyStatusLabel", () => {
  it("is total — every ShotRequestStatus maps to a non-empty label", () => {
    for (const status of ALL_STATUSES) {
      expect(friendlyStatusLabel(status, false).length).toBeGreaterThan(0);
    }
  });

  it("`proposed` distinguishes whether the ask has actually posted yet", () => {
    expect(friendlyStatusLabel("proposed", false)).toContain("Awaiting idea");
    expect(friendlyStatusLabel("proposed", true)).toContain("Proposal sent");
  });

  it("`hasLivingPost` is ignored for every other status", () => {
    for (const status of ALL_STATUSES) {
      if (status === "proposed") continue;
      expect(friendlyStatusLabel(status, true)).toBe(
        friendlyStatusLabel(status, false),
      );
    }
  });

  it.each<[ShotRequestStatus, string]>([
    ["done", "Done"],
    ["parked", "Parked"],
    ["failed", "Failed"],
    ["drafting", "Drafting"],
    ["in_review", "Awaiting review"],
    ["picking", "Awaiting pick"],
  ])("%s reads as %j", (status, expected) => {
    expect(friendlyStatusLabel(status, false)).toContain(expected);
  });
});

describe("plainStatusLabel", () => {
  it("is total and carries no emoji (for the CSV export)", () => {
    for (const status of ALL_STATUSES) {
      const label = plainStatusLabel(status);
      expect(label.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex -- deliberately checking for non-ASCII (emoji)
      expect(/^[\x00-\x7F]*$/.test(label)).toBe(true);
    }
  });

  it.each<[ShotRequestStatus, string]>([
    ["done", "done"],
    ["parked", "parked"],
    ["failed", "failed"],
    ["proposed", "awaiting idea"],
  ])("%s -> %j", (status, expected) => {
    expect(plainStatusLabel(status)).toBe(expected);
  });
});

describe("isBatchComplete", () => {
  it("is true for an empty batch (vacuously complete)", () => {
    expect(isBatchComplete([])).toBe(true);
  });

  it("is true only when every status is terminal (done/parked/failed)", () => {
    expect(isBatchComplete(["done", "parked", "failed"])).toBe(true);
    expect(isBatchComplete(["done", "done"])).toBe(true);
  });

  it("is false if any single status is non-terminal", () => {
    expect(isBatchComplete(["done", "proposed"])).toBe(false);
    expect(isBatchComplete(["done", "confirmed"])).toBe(false);
    expect(isBatchComplete(["picking"])).toBe(false);
  });

  it("`stale` is not terminal — a batch with a stale row is not complete", () => {
    expect(isBatchComplete(["done", "stale"])).toBe(false);
  });
});
