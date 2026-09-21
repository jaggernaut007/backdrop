import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const REQUIRED = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C123",
  APPROVER_SLACK_USER_ID: "U_APPROVER",
  ESCALATION_SLACK_USER_ID: "U_ESCALATION",
  LUMA_AGENTS_API_KEY: "luma-test",
};

describe("loadConfig", () => {
  it("throws a named error when a required var is missing", () => {
    const { SLACK_BOT_TOKEN: _omit, ...rest } = REQUIRED;
    expect(() => loadConfig({ ...rest })).toThrow(
      /Missing required environment variable: SLACK_BOT_TOKEN/,
    );
  });

  it("throws when a numeric var is non-numeric", () => {
    expect(() =>
      loadConfig({ ...REQUIRED, DRAFT_COST_CENTS: "cheap" }),
    ).toThrow(/Env DRAFT_COST_CENTS is not a number: cheap/);
  });

  it("throws when a count var is zero, negative, or fractional", () => {
    for (const bad of ["0", "-2", "2.5"]) {
      expect(() =>
        loadConfig({ ...REQUIRED, FINALS_PER_DIRECTION: bad }),
      ).toThrow(/FINALS_PER_DIRECTION must be a positive integer/);
    }
  });

  it("applies the documented ASSUMPTIONS.md Part C defaults", () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.port).toBe(8080);
    expect(cfg.pipeline.staleThresholdDays).toBe(3);
    expect(cfg.pipeline.finalsPerDirection).toBe(2);
    expect(cfg.pipeline.draftCostCents).toBe(5);
    expect(cfg.pipeline.finalCostCents).toBe(11);
    expect(cfg.pipeline.pollIntervalMs).toBe(5_000);
    expect(cfg.pipeline.maxInFlightGenerations).toBe(4);
    expect(cfg.pipeline.maxDraftsPerTick).toBe(2);
    expect(cfg.pipeline.maxFinalsStartsPerTick).toBe(1);
    expect(cfg.luma.baseUrl).toBe("https://agents.lumalabs.ai/v1");
  });

  it("OPEN_APPROVAL: defaults on (open-by-default posture); only false/0/no (and junk) turn it off", () => {
    // Unset or empty → the default, which is `true`: anyone with the invite can approve.
    expect(loadConfig({ ...REQUIRED }).slack.openApproval).toBe(true);
    expect(
      loadConfig({ ...REQUIRED, OPEN_APPROVAL: "" }).slack.openApproval,
    ).toBe(true);
    for (const on of ["true", "TRUE", "1", "yes", " Yes "]) {
      expect(
        loadConfig({ ...REQUIRED, OPEN_APPROVAL: on }).slack.openApproval,
      ).toBe(true);
    }
    for (const off of ["false", "FALSE", "0", "no", "maybe"]) {
      expect(
        loadConfig({ ...REQUIRED, OPEN_APPROVAL: off }).slack.openApproval,
      ).toBe(false);
    }
  });

  it("is pure — does not copy the passed env into process.env", () => {
    delete process.env.SHOT_PIPELINE_SENTINEL;
    loadConfig({ ...REQUIRED, SHOT_PIPELINE_SENTINEL: "leaked" });
    expect(process.env.SHOT_PIPELINE_SENTINEL).toBeUndefined();
  });

  it("reads overrides from the passed env, not process.env", () => {
    const cfg = loadConfig({
      ...REQUIRED,
      STALE_THRESHOLD_DAYS: "5",
      PUBLIC_BASE_URL: "https://x.dev",
    });
    expect(cfg.pipeline.staleThresholdDays).toBe(5);
    expect(cfg.publicBaseUrl).toBe("https://x.dev");
  });
});
