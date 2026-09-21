import type { Clock } from "../ports/clock.js";

/** Real wall-clock. Tests use FakeClock instead. */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
  nowMs(): number {
    return Date.now();
  }
}
