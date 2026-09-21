import type { Clock } from "../../src/ports/clock.js";

/** A clock you can set and advance. Makes SPEC F3b's "3 days ago" a one-liner. */
export class FakeClock implements Clock {
  private ms: number;

  constructor(start: string | number = "2026-01-01T00:00:00.000Z") {
    this.ms = typeof start === "number" ? start : Date.parse(start);
  }

  now(): string {
    return new Date(this.ms).toISOString();
  }

  nowMs(): number {
    return this.ms;
  }

  set(instant: string | number): void {
    this.ms = typeof instant === "number" ? instant : Date.parse(instant);
  }

  advanceDays(days: number): void {
    this.ms += days * 24 * 60 * 60 * 1000;
  }

  advanceMs(ms: number): void {
    this.ms += ms;
  }
}
