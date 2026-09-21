import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  approveDraft,
  beginFinals,
  confirmRequest,
  failDraftGeneration,
  failFinalsGeneration,
  finishPicking,
  IllegalTransition,
  isBindingActor,
  markStale,
  NonBindingActor,
  openFinalsPicking,
  postDraftForReview,
  rejectDraft,
  startDrafting,
} from "../../src/domain/shot-request.js";
import type { ShotRequest, ShotRequestStatus } from "../../src/domain/types.js";

const ELLIE = "U_APPROVER";

function req(over: Partial<ShotRequest> = {}): ShotRequest {
  return {
    id: "r1",
    sku: "HG-002",
    ideaRevision: 1,
    status: "confirmed",
    shotIdeaText: "a windowsill",
    shotIdeaOrigin: "sheet",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-09-06T12:00:00.000Z",
    draftPostedAt: null,
    escalatedAt: null,
    ...over,
  };
}

describe("isBindingActor", () => {
  it("is true only for a non-empty actor that equals the configured id", () => {
    expect(isBindingActor(ELLIE, ELLIE)).toBe(true);
    expect(isBindingActor("U_OTHER", ELLIE)).toBe(false);
    expect(isBindingActor("", "")).toBe(false);
  });
});

describe("ShotRequest transitions", () => {
  it("confirmed → drafting → in_review → approved along the happy path", () => {
    const drafting = startDrafting(req());
    expect(drafting.status).toBe("drafting");

    const inReview = postDraftForReview(drafting, "2026-09-06T13:00:00.000Z");
    expect(inReview.status).toBe("in_review");
    expect(inReview.draftPostedAt).toBe("2026-09-06T13:00:00.000Z");

    const approved = approveDraft(inReview, ELLIE, ELLIE);
    expect(approved.status).toBe("approved");
  });

  it("a first reject re-enters drafting AND grants the retry; a second reject parks", () => {
    const first = rejectDraft(
      req({ status: "in_review", retryUsed: false }),
      ELLIE,
      ELLIE,
    );
    expect(first.status).toBe("drafting");
    expect(first.retryUsed).toBe(true); // the one retry is now spent

    const second = rejectDraft(
      req({ status: "in_review", retryUsed: true }),
      ELLIE,
      ELLIE,
    );
    expect(second.status).toBe("parked");
  });

  it("property: reject parks iff a retry was used, else re-drafts — and never authorises Finals", () => {
    fc.assert(
      fc.property(fc.boolean(), (retryUsed) => {
        const next = rejectDraft(
          req({ status: "in_review", retryUsed }),
          ELLIE,
          ELLIE,
        );
        expect(next.status).toBe(retryUsed ? "parked" : "drafting");
        expect(["approved", "finalizing", "picking", "done"]).not.toContain(
          next.status,
        );
      }),
    );
  });

  it("no review transition fires for a non-binding actor", () => {
    const inReview = req({ status: "in_review" });
    expect(() => approveDraft(inReview, "U_OTHER", ELLIE)).toThrow(
      NonBindingActor,
    );
    expect(() => rejectDraft(inReview, "U_OTHER", ELLIE)).toThrow(
      NonBindingActor,
    );
  });

  it("failDraftGeneration moves drafting → failed", () => {
    expect(failDraftGeneration(req({ status: "drafting" })).status).toBe(
      "failed",
    );
  });

  it("markStale moves in_review → stale and stamps escalatedAt (F3b)", () => {
    const stale = markStale(
      req({ status: "in_review", draftPostedAt: "2026-09-03T12:00:00.000Z" }),
      "2026-09-06T12:00:00.000Z",
    );
    expect(stale.status).toBe("stale");
    expect(stale.escalatedAt).toBe("2026-09-06T12:00:00.000Z");
  });

  it("markStale only runs from in_review — never re-fires once escalated", () => {
    const illegalFrom: ShotRequestStatus[] = [
      "confirmed",
      "drafting",
      "approved",
      "finalizing",
      "picking",
      "done",
      "parked",
      "failed",
      "stale",
    ];
    for (const status of illegalFrom) {
      expect(() => markStale(req({ status }), "2026-09-06T12:00:00.000Z")).toThrow(
        IllegalTransition,
      );
    }
  });

  it("an escalated (stale) Draft is still tappable — Approve and Reject both apply to it", () => {
    const staleFresh = req({
      status: "stale",
      retryUsed: false,
      escalatedAt: "2026-09-06T12:00:00.000Z",
    });
    expect(approveDraft(staleFresh, ELLIE, ELLIE).status).toBe("approved");
    expect(rejectDraft(staleFresh, ELLIE, ELLIE).status).toBe("drafting"); // first reject → retry
    expect(
      rejectDraft({ ...staleFresh, retryUsed: true }, ELLIE, ELLIE).status,
    ).toBe("parked"); // reject after the retry was spent → parked

    // still gated on the binding actor
    expect(() => approveDraft(staleFresh, "U_OTHER", ELLIE)).toThrow(
      NonBindingActor,
    );
  });

  it("approved → finalizing → picking along the Finals path", () => {
    const finalizing = beginFinals(req({ status: "approved" }));
    expect(finalizing.status).toBe("finalizing");
    expect(openFinalsPicking(finalizing).status).toBe("picking");
  });

  it("beginFinals is the DraftApproved guard — it throws for any non-approved state", () => {
    const illegalFrom: ShotRequestStatus[] = [
      "confirmed",
      "drafting",
      "in_review",
      "finalizing",
      "picking",
      "done",
      "parked",
    ];
    for (const status of illegalFrom) {
      expect(() => beginFinals(req({ status }))).toThrow(IllegalTransition);
    }
  });

  it("failFinalsGeneration moves finalizing → failed", () => {
    expect(failFinalsGeneration(req({ status: "finalizing" })).status).toBe(
      "failed",
    );
    expect(() => failFinalsGeneration(req({ status: "approved" }))).toThrow(
      IllegalTransition,
    );
  });

  it("finishPicking: ≥2 picks → done, exactly 1 → parked, 0 → unchanged picking", () => {
    expect(
      finishPicking(req({ status: "picking" }), { pickCount: 3 }).status,
    ).toBe("done");
    expect(
      finishPicking(req({ status: "picking" }), { pickCount: 2 }).status,
    ).toBe("done");
    expect(
      finishPicking(req({ status: "picking" }), { pickCount: 1 }).status,
    ).toBe("parked");
    const zero = req({ status: "picking" });
    expect(finishPicking(zero, { pickCount: 0 }).status).toBe("picking");
  });

  it("finishPicking only runs from picking", () => {
    expect(() =>
      finishPicking(req({ status: "approved" }), { pickCount: 2 }),
    ).toThrow(IllegalTransition);
  });

  it("property: finishPicking never yields done with fewer than 2 picks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9 }), (pickCount) => {
        const next = finishPicking(req({ status: "picking" }), { pickCount });
        if (next.status === "done") expect(pickCount).toBeGreaterThanOrEqual(2);
        if (pickCount === 1) expect(next.status).toBe("parked");
      }),
    );
  });

  it("rejects illegal transitions with the current and expected states named", () => {
    const illegalFrom: ShotRequestStatus[] = [
      "proposed",
      "in_review",
      "approved",
      "done",
      "parked",
    ];
    for (const status of illegalFrom) {
      expect(() => startDrafting(req({ status }))).toThrow(IllegalTransition);
    }
    expect(() =>
      approveDraft(req({ status: "confirmed" }), ELLIE, ELLIE),
    ).toThrow(IllegalTransition);
    expect(() => postDraftForReview(req({ status: "in_review" }), "t")).toThrow(
      IllegalTransition,
    );
  });

  it("confirmRequest moves proposed → confirmed with the given text and origin", () => {
    const proposed = req({
      status: "proposed",
      shotIdeaText: "Sage Linen napkins, styled on a neutral surface with soft natural light",
      shotIdeaOrigin: "proposed",
    });

    const confirmedAsIs = confirmRequest(proposed, {
      text: "Sage Linen napkins, styled on a neutral surface with soft natural light",
      origin: "proposed",
    });
    expect(confirmedAsIs.status).toBe("confirmed");
    expect(confirmedAsIs.shotIdeaOrigin).toBe("proposed");

    const confirmedEdited = confirmRequest(proposed, {
      text: "folded on a sunlit oak table, soft morning shadows",
      origin: "proposed-then-edited",
    });
    expect(confirmedEdited.status).toBe("confirmed");
    expect(confirmedEdited.shotIdeaText).toBe(
      "folded on a sunlit oak table, soft morning shadows",
    );
    expect(confirmedEdited.shotIdeaOrigin).toBe("proposed-then-edited");

    const confirmedReply = confirmRequest(proposed, {
      text: "on a lit shelf",
      origin: "slack-reply",
    });
    expect(confirmedReply.shotIdeaOrigin).toBe("slack-reply");
  });

  it("confirmRequest only runs from proposed", () => {
    const illegalFrom: ShotRequestStatus[] = [
      "confirmed",
      "drafting",
      "in_review",
      "approved",
      "done",
      "parked",
    ];
    for (const status of illegalFrom) {
      expect(() =>
        confirmRequest(req({ status }), { text: "x", origin: "slack-reply" }),
      ).toThrow(IllegalTransition);
    }
  });

  it("returns a new object — the input is not mutated", () => {
    const original = req();
    const next = startDrafting(original);
    expect(original.status).toBe("confirmed");
    expect(next).not.toBe(original);
  });
});
