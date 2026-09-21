import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import { handleDecision } from "../../src/app/handle-decision.js";
import type {
  GenerationAttempt,
  ReviewPost,
  ShotRequest,
} from "../../src/domain/types.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const ELLIE = "U_APPROVER";

const ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_CHANNEL_ID: "C_TEST",
  APPROVER_SLACK_USER_ID: ELLIE,
  ESCALATION_SLACK_USER_ID: "U_ESCALATION",
  LUMA_AGENTS_API_KEY: "luma-api-test",
  // This suite exercises the gated F3a behaviour; the open-approval default is covered in its own
  // block below and in config.test.ts.
  OPEN_APPROVAL: "false",
};

describe("handleDecision", () => {
  let repo: InMemoryRepository;
  let slack: FakeSlackGateway;
  let clock: FakeClock;
  let config: Config;

  const inReviewRequest = (over: Partial<ShotRequest> = {}): ShotRequest => ({
    id: "r1",
    sku: "HG-002",
    ideaRevision: 1,
    status: "in_review",
    shotIdeaText: "a windowsill",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-09-06T12:00:00.000Z",
    draftPostedAt: "2026-09-06T12:30:00.000Z",
    escalatedAt: null,
    ...over,
  });

  function seedDraftPostAndAttempt(): void {
    const attempt: GenerationAttempt = {
      id: "a1",
      requestId: "r1",
      kind: "draft",
      promptText: "…",
      inputPhotoUrl: "https://catalog.test/hg-002.jpg",
      lumaGenerationId: "gen_1",
      resultImageUrl: "https://pipeline.test/img/hg-002-draft-abcd1234.jpg",
      spendCents: 5,
      status: "succeeded",
      rejectReason: null,
      createdAt: "2026-09-06T12:20:00.000Z",
      completedAt: "2026-09-06T12:25:00.000Z",
    };
    repo.saveAttempt(attempt);
    const post: ReviewPost = {
      id: "rp1",
      requestId: "r1",
      attemptId: "a1",
      slackChannel: "C_TEST",
      slackTs: "1700000000.000123",
      kind: "draft",
      createdAt: "2026-09-06T12:30:00.000Z",
    };
    repo.saveReviewPost(post);
  }

  beforeEach(() => {
    repo = new InMemoryRepository();
    slack = new FakeSlackGateway();
    clock = new FakeClock("2026-09-07T09:00:00.000Z");
    config = loadConfig(ENV);
    repo.saveRequest(inReviewRequest());
    seedDraftPostAndAttempt();
  });

  const deps = () => ({ repo, clock, gateway: slack, config });

  it("approve: moves to approved, records the Decision against the draft attempt, swaps controls", async () => {
    const res = await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "approve",
    });

    expect(res).toMatchObject({ applied: true, newStatus: "approved" });
    expect(repo.getRequest("r1")?.status).toBe("approved");
    const [d] = repo.listDecisionsForRequest("r1");
    expect(d).toMatchObject({
      actor: ELLIE,
      verb: "approve",
      reason: null,
      attemptId: "a1",
    });
    expect(d?.at).toBe("2026-09-07T09:00:00.000Z");

    const updates = slack.posts.filter((p) => p.kind === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.meta?.["keepImageUrl"]).toContain("/img/");
    // Fix 6: the terminal update includes the SKU in both the text and the image alt-text.
    expect(updates[0]?.text).toContain("*HG-002*");
    expect(updates[0]?.meta?.["sku"]).toBe("HG-002");
  });

  it("reject: records the reason, re-enters drafting (first reject), writes no finals spend", async () => {
    const res = await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "reject",
      reason: "color off",
    });

    expect(res).toMatchObject({ applied: true, newStatus: "drafting" });
    const [d] = repo.listDecisionsForRequest("r1");
    expect(d).toMatchObject({ verb: "reject", reason: "color off" });
    expect(
      repo.listAttemptsForRequest("r1").every((a) => a.kind !== "final"),
    ).toBe(true);
    // Fix 6: the reject update also includes the SKU in the text.
    const updates = slack.posts.filter((p) => p.kind === "update");
    expect(updates[0]?.text).toContain("*HG-002*");
    expect(updates[0]?.text).toContain("color off");
  });

  it("reject with no chip defaults the reason to `other`", async () => {
    await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "reject",
    });
    expect(repo.listDecisionsForRequest("r1")[0]?.reason).toBe("other");
  });

  it("second reject (retry already used) parks the Request", async () => {
    repo.saveRequest(inReviewRequest({ retryUsed: true }));
    const res = await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "reject",
      reason: "wrong vibe",
    });
    expect(res.newStatus).toBe("parked");
  });

  it("a non-binding actor is a total no-op — no Decision, no state change, no Slack update", async () => {
    const res = await handleDecision(deps(), {
      requestId: "r1",
      actor: "U_WEBPERSON",
      verb: "approve",
    });
    expect(res).toEqual({ applied: false, ignoredReason: "not-binding-actor" });
    expect(repo.getRequest("r1")?.status).toBe("in_review");
    expect(repo.listDecisionsForRequest("r1")).toHaveLength(0);
    expect(slack.posts.filter((p) => p.kind === "update")).toHaveLength(0);
  });

  it("is idempotent against redelivery — a second tap on an already-approved Request is ignored", async () => {
    await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "approve",
    });
    const res = await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "reject",
      reason: "other",
    });
    expect(res).toEqual({ applied: false, ignoredReason: "not-in-review" });
    expect(repo.getRequest("r1")?.status).toBe("approved");
    expect(repo.listDecisionsForRequest("r1")).toHaveLength(1);
  });

  it("an unknown requestId is ignored, not thrown", async () => {
    const res = await handleDecision(deps(), {
      requestId: "nope",
      actor: ELLIE,
      verb: "approve",
    });
    expect(res).toEqual({ applied: false, ignoredReason: "request-not-found" });
  });

  it("a binding tap on an in_review Request with no draft ReviewPost still records the Decision", async () => {
    repo = new InMemoryRepository(); // no seedDraftPostAndAttempt
    repo.saveRequest(inReviewRequest());

    const res = await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "approve",
    });

    expect(res.applied).toBe(true);
    expect(repo.getRequest("r1")?.status).toBe("approved");
    expect(repo.listDecisionsForRequest("r1")[0]).toMatchObject({
      verb: "approve",
      attemptId: null,
    });
    expect(slack.posts.filter((p) => p.kind === "update")).toHaveLength(0);
  });

  it("a failure swapping the Slack controls does not lose the Decision or the transition", async () => {
    slack.failNext("update");
    const res = await handleDecision(deps(), {
      requestId: "r1",
      actor: ELLIE,
      verb: "approve",
    });

    expect(res).toMatchObject({ applied: true, newStatus: "approved" });
    expect(repo.getRequest("r1")?.status).toBe("approved");
    expect(repo.listDecisionsForRequest("r1")).toHaveLength(1);
  });

  it("property: no non-binding actor can ever move the Request or write a Decision", () => {
    fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s !== ELLIE),
        fc.constantFrom("approve" as const, "reject" as const),
        fc.constantFrom(
          "wrong vibe" as const,
          "color off" as const,
          "too staged" as const,
          "other" as const,
        ),
        async (actor, verb, reason) => {
          const r = new InMemoryRepository();
          r.saveRequest(inReviewRequest());
          const before = r.getRequest("r1");
          const out = await handleDecision(
            { repo: r, clock, gateway: slack, config },
            { requestId: "r1", actor, verb, reason },
          );
          expect(out.applied).toBe(false);
          expect(r.getRequest("r1")).toEqual(before);
          expect(r.listDecisionsForRequest("r1")).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  describe("open approval (OPEN_APPROVAL) — binding-actor gate lifted, the open-by-default", () => {
    let openConfig: Config;

    beforeEach(() => {
      // Omit the var entirely — `openApproval` must default to true.
      const { OPEN_APPROVAL: _off, ...openEnv } = ENV;
      openConfig = loadConfig(openEnv);
      expect(openConfig.slack.openApproval).toBe(true);
    });

    const openDeps = () => ({ repo, clock, gateway: slack, config: openConfig });

    it("a non-approver actor can approve — Decision recorded against that actor, Request advances", async () => {
      const res = await handleDecision(openDeps(), {
        requestId: "r1",
        actor: "U_MEMBER",
        verb: "approve",
      });

      expect(res).toMatchObject({ applied: true, newStatus: "approved" });
      expect(repo.getRequest("r1")?.status).toBe("approved");
      expect(repo.listDecisionsForRequest("r1")[0]).toMatchObject({
        actor: "U_MEMBER",
        verb: "approve",
      });
    });

    it("a non-approver actor can reject — reason recorded, re-enters drafting", async () => {
      const res = await handleDecision(openDeps(), {
        requestId: "r1",
        actor: "U_MEMBER",
        verb: "reject",
        reason: "too staged",
      });

      expect(res).toMatchObject({ applied: true, newStatus: "drafting" });
      expect(repo.listDecisionsForRequest("r1")[0]).toMatchObject({
        actor: "U_MEMBER",
        verb: "reject",
        reason: "too staged",
      });
    });

    it("an empty actor id is still never binding, even with the gate lifted", async () => {
      const res = await handleDecision(openDeps(), {
        requestId: "r1",
        actor: "",
        verb: "approve",
      });
      expect(res).toEqual({ applied: false, ignoredReason: "not-binding-actor" });
      expect(repo.getRequest("r1")?.status).toBe("in_review");
    });
  });
});
