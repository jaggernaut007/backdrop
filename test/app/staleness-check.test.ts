import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { runStalenessCheck } from "../../src/app/staleness-check.js";
import type { ShotRequest } from "../../src/domain/types.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C_TEST",
  APPROVER_SLACK_USER_ID: "U_APPROVER",
  ESCALATION_SLACK_USER_ID: "U_ESCALATION",
  LUMA_AGENTS_API_KEY: "luma-api-test",
  STALE_THRESHOLD_DAYS: "3",
};

describe("runStalenessCheck", () => {
  let repo: InMemoryRepository;
  let slack: FakeSlackGateway;
  let clock: FakeClock;
  let config: Config;

  const inReview = (over: Partial<ShotRequest> = {}): ShotRequest => ({
    id: "r1",
    sku: "HG-002",
    ideaRevision: 1,
    status: "in_review",
    shotIdeaText: "on a sunlit windowsill",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-09-01T12:00:00.000Z",
    draftPostedAt: "2026-09-01T12:00:00.000Z",
    escalatedAt: null,
    ...over,
  });

  const deps = () => ({ repo, clock, gateway: slack, config });

  beforeEach(() => {
    repo = new InMemoryRepository();
    slack = new FakeSlackGateway();
    clock = new FakeClock("2026-09-05T12:00:00.000Z"); // 4 days after the draft above
    config = loadConfig(ENV);
  });

  it("escalates an in_review Draft older than the threshold and marks it stale", async () => {
    repo.saveRequest(inReview());

    const res = await runStalenessCheck(deps());

    expect(res.escalated).toBe(1);
    expect(repo.getRequest("r1")?.status).toBe("stale");
    expect(repo.getRequest("r1")?.escalatedAt).toBe(clock.now());
    const mentions = slack.postsOfKind("mention-escalation");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.text).toContain("<@U_ESCALATION>");
    expect(mentions[0]?.text).toContain("HG-002");
  });

  it("leaves a Draft still inside the threshold alone", async () => {
    clock.set("2026-09-03T11:59:00.000Z"); // just under 3 days after draftPostedAt
    repo.saveRequest(inReview());

    const res = await runStalenessCheck(deps());

    expect(res.escalated).toBe(0);
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(slack.postsOfKind("mention-escalation")).toHaveLength(0);
  });

  it("escalates exactly at the threshold boundary", async () => {
    clock.set("2026-09-04T12:00:00.000Z"); // exactly 3 days
    repo.saveRequest(inReview());

    const res = await runStalenessCheck(deps());

    expect(res.escalated).toBe(1);
    expect(repo.getRequest("r1")?.status).toBe("stale");
  });

  it("skips a Request with no draftPostedAt timestamp", async () => {
    repo.saveRequest(inReview({ draftPostedAt: null }));

    const res = await runStalenessCheck(deps());

    expect(res.escalated).toBe(0);
    expect(repo.getRequest("r1")?.status).toBe("in_review");
  });

  it("only scans in_review Requests — a stale one is never re-escalated", async () => {
    repo.saveRequest(
      inReview({ status: "stale", escalatedAt: "2026-09-02T00:00:00.000Z" }),
    );
    repo.saveRequest(
      inReview({ id: "r2", status: "approved", draftPostedAt: "2026-09-01T00:00:00.000Z" }),
    );

    const res = await runStalenessCheck(deps());

    expect(res.escalated).toBe(0);
    expect(slack.postsOfKind("mention-escalation")).toHaveLength(0);
  });

  it("post-before-transition: a failed mentionEscalationContact leaves the Request in_review for the next sweep", async () => {
    repo.saveRequest(inReview());
    slack.failNext("mention-escalation");
    const errors: string[] = [];

    const res = await runStalenessCheck({
      ...deps(),
      onItemError: (context) => errors.push(context),
    });

    expect(res.escalated).toBe(0);
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("r1");

    // The next sweep succeeds now that Slack is healthy again.
    const retry = await runStalenessCheck(deps());
    expect(retry.escalated).toBe(1);
    expect(repo.getRequest("r1")?.status).toBe("stale");
  });

  it("falls back to console.error for a sweep error when no onItemError is wired", async () => {
    repo.saveRequest(inReview());
    slack.failNext("mention-escalation");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await runStalenessCheck(deps());

    expect(res.escalated).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    spy.mockRestore();
  });
});
