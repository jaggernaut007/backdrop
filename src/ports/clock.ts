/** Time as a dependency, so staleness (SPEC F3b: "3 days ago") is testable without real waits. */
export interface Clock {
  /** Current instant as an ISO-8601 string (UTC). */
  now(): string;
  /** Current instant as epoch milliseconds. */
  nowMs(): number;
}
