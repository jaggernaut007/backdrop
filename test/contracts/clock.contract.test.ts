import { describe, expect, it } from "vitest";

import { SystemClock } from "../../src/adapters/system-clock.js";
import type { Clock } from "../../src/ports/clock.js";
import { FakeClock } from "../fakes/fake-clock.js";

/**
 * One behavioural contract, run against every Clock implementation. Keeps FakeClock from drifting
 * away from the real adapter as the codebase grows.
 */
function runClockContract(name: string, make: () => Clock): void {
  describe(`Clock contract: ${name}`, () => {
    it("now() is a valid ISO-8601 UTC instant", () => {
      expect(make().now()).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it("now() and nowMs() agree", () => {
      const c = make();
      // Two live reads can straddle a millisecond, so bracket rather than equate: the ISO instant
      // must land within the [before, after] window of a nowMs() pair taken around it.
      const before = c.nowMs();
      const iso = new Date(c.now()).getTime();
      const after = c.nowMs();
      expect(iso).toBeGreaterThanOrEqual(before);
      expect(iso).toBeLessThanOrEqual(after);
    });

    it("nowMs() never goes backwards across reads", () => {
      const c = make();
      const a = c.nowMs();
      const b = c.nowMs();
      expect(b).toBeGreaterThanOrEqual(a);
    });
  });
}

runClockContract("SystemClock", () => new SystemClock());
runClockContract("FakeClock", () => new FakeClock("2026-01-01T00:00:00.000Z"));

describe("FakeClock — advance controls", () => {
  it("advanceDays / advanceMs / set move now() deterministically", () => {
    const c = new FakeClock("2026-01-01T00:00:00.000Z");
    c.advanceDays(3);
    expect(c.now()).toBe("2026-01-04T00:00:00.000Z");
    c.advanceMs(1000);
    expect(c.now()).toBe("2026-01-04T00:00:01.000Z");
    c.set("2026-02-01T00:00:00.000Z");
    expect(c.nowMs()).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
  });

  it("accepts a numeric epoch-ms constructor argument", () => {
    const c = new FakeClock(0);
    expect(c.now()).toBe("1970-01-01T00:00:00.000Z");
  });
});
