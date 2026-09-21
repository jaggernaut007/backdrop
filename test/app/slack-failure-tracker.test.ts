import { describe, expect, it } from "vitest";

import {
  MAX_CONSECUTIVE_SLACK_FAILURES,
  SlackFailureTracker,
} from "../../src/app/slack-failure-tracker.js";

describe("SlackFailureTracker", () => {
  it("returns false until a key has failed MAX_CONSECUTIVE_SLACK_FAILURES times in a row", () => {
    const tracker = new SlackFailureTracker();
    for (let i = 0; i < MAX_CONSECUTIVE_SLACK_FAILURES - 1; i++) {
      expect(tracker.recordFailure("r1")).toBe(false);
    }
    expect(tracker.recordFailure("r1")).toBe(true);
  });

  it("keeps counting past the threshold if the caller doesn't clear", () => {
    const tracker = new SlackFailureTracker();
    for (let i = 0; i < MAX_CONSECUTIVE_SLACK_FAILURES; i++) tracker.recordFailure("r1");
    expect(tracker.recordFailure("r1")).toBe(true);
  });

  it("clear() resets the streak so the next failure starts counting from one again", () => {
    const tracker = new SlackFailureTracker();
    for (let i = 0; i < MAX_CONSECUTIVE_SLACK_FAILURES - 1; i++) {
      tracker.recordFailure("r1");
    }
    tracker.clear("r1");
    for (let i = 0; i < MAX_CONSECUTIVE_SLACK_FAILURES - 1; i++) {
      expect(tracker.recordFailure("r1")).toBe(false);
    }
    expect(tracker.recordFailure("r1")).toBe(true);
  });

  it("clear() on a key with no recorded failures is a harmless no-op", () => {
    const tracker = new SlackFailureTracker();
    expect(() => tracker.clear("never-failed")).not.toThrow();
  });

  it("tracks each key independently", () => {
    const tracker = new SlackFailureTracker();
    for (let i = 0; i < MAX_CONSECUTIVE_SLACK_FAILURES - 1; i++) {
      tracker.recordFailure("r1");
    }
    expect(tracker.recordFailure("r2")).toBe(false); // r2's own streak, unaffected by r1's
    expect(tracker.recordFailure("r1")).toBe(true); // r1 crosses its own threshold
  });
});
