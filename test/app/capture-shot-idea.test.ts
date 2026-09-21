import { beforeEach, describe, expect, it } from "vitest";

import { captureShotIdea } from "../../src/app/capture-shot-idea.js";
import type { ShotRequest } from "../../src/domain/types.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

describe("captureShotIdea", () => {
  let repo: InMemoryRepository;
  let slack: FakeSlackGateway;
  let clock: FakeClock;

  const deps = () => ({ repo, gateway: slack, clock });

  const proposedRequest = (over: Partial<ShotRequest> = {}): ShotRequest => ({
    id: "r1",
    sku: "HG-014",
    ideaRevision: 1,
    status: "proposed",
    shotIdeaText: "Sage Linen napkins, styled on a neutral surface with soft natural light",
    shotIdeaOrigin: "proposed",
    priorityRank: 0,
    riskFlags: [],
    lifecycleFlag: null,
    bundlingFlag: null,
    retryUsed: false,
    createdAt: "2026-09-06T12:00:00.000Z",
    draftPostedAt: null,
    escalatedAt: null,
    ...over,
  });

  beforeEach(() => {
    repo = new InMemoryRepository();
    slack = new FakeSlackGateway();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
  });

  it("confirms a proposed Request (no importId — no thread update, no batch refresh)", async () => {
    repo.saveRequest(proposedRequest());

    const res = await captureShotIdea(deps(), {
      sku: "HG-014",
      text: "folded on a sunlit oak table, soft morning shadows",
      origin: "slack-reply",
    });

    expect(res.applied).toBe(true);
    expect(res.newStatus).toBe("confirmed");
    const updated = repo.getRequest("r1");
    expect(updated?.status).toBe("confirmed");
    expect(updated?.shotIdeaText).toBe(
      "folded on a sunlit oak table, soft morning shadows",
    );
    expect(updated?.shotIdeaOrigin).toBe("slack-reply");
  });

  it("confirms with proposed and proposed-then-edited origins too", async () => {
    repo.saveRequest(proposedRequest());
    const accepted = await captureShotIdea(deps(), {
      sku: "HG-014",
      text: "Sage Linen napkins, styled on a neutral surface with soft natural light",
      origin: "proposed",
    });
    expect(accepted.applied).toBe(true);
    expect(repo.getRequest("r1")?.shotIdeaOrigin).toBe("proposed");

    repo.saveRequest(proposedRequest({ id: "r2", sku: "HG-015" }));
    const edited = await captureShotIdea(deps(), {
      sku: "HG-015",
      text: "on a marble counter",
      origin: "proposed-then-edited",
    });
    expect(edited.applied).toBe(true);
    expect(repo.getRequest("r2")?.shotIdeaOrigin).toBe("proposed-then-edited");
  });

  it("with an importId: updates the SKU's living thread reply and refreshes the batch status post", async () => {
    repo.saveImport({
      id: "imp1",
      receivedAt: "2026-09-06T12:00:00.000Z",
      sourceRef: "F_TEST",
      contentHash: "h1",
      rowCount: 1,
      nWithIdea: 0,
      nBlank: 1,
      nDone: 0,
    });
    repo.saveCatalogImportRow("imp1", "HG-014");
    repo.upsertProduct({
      sku: "HG-014",
      name: "Table Runner",
      category: "Textiles",
      colorRaw: "Clay Pink",
      colorSet: { matched: ["Clay Pink"], unmatched: [] },
      material: "Linen",
      priceCents: 4200,
      photoUrl: "https://x/hg-014.jpg",
      notesRaw: "",
      updatedAt: "2026-09-06T12:00:00.000Z",
    });
    repo.saveRequest(proposedRequest());
    repo.saveBatchStatusPost({
      importId: "imp1",
      slackChannel: "C_TEST",
      slackTs: "1700000000.000001",
      completedAt: null,
      exportUploadedAt: null,
    });
    repo.saveSkuThreadPost({
      importId: "imp1",
      sku: "HG-014",
      slackChannel: "C_TEST",
      slackTs: "1700000000.000002",
      stage: "ask",
      requestId: null,
      proposedText: proposedRequest().shotIdeaText,
      updatedAt: "2026-09-06T12:00:00.000Z",
    });

    await captureShotIdea(deps(), {
      sku: "HG-014",
      text: "on a lit shelf",
      origin: "proposed",
      importId: "imp1",
    });

    const updates = slack.postsOfKind("update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.ts).toBe("1700000000.000002");

    // The batch status post was refreshed in place — same ts, "updated" (not a new message).
    const batchUpdates = slack.postsOfKind("batch-status");
    expect(batchUpdates).toHaveLength(1);
    expect(batchUpdates[0]?.updated).toBe(true);
    expect(batchUpdates[0]?.ts).toBe("1700000000.000001");
  });

  it("replaceThreadReply (edit-modal path): deletes the stale ask reply and reposts a fresh one", async () => {
    repo.saveImport({
      id: "imp1",
      receivedAt: "2026-09-06T12:00:00.000Z",
      sourceRef: "F_TEST",
      contentHash: "h1",
      rowCount: 1,
      nWithIdea: 0,
      nBlank: 1,
      nDone: 0,
    });
    repo.saveCatalogImportRow("imp1", "HG-014");
    repo.saveRequest(proposedRequest());
    repo.saveBatchStatusPost({
      importId: "imp1",
      slackChannel: "C_TEST",
      slackTs: "1700000000.000001",
      completedAt: null,
      exportUploadedAt: null,
    });
    repo.saveSkuThreadPost({
      importId: "imp1",
      sku: "HG-014",
      slackChannel: "C_TEST",
      slackTs: "1700000000.000002",
      stage: "ask",
      requestId: null,
      proposedText: proposedRequest().shotIdeaText,
      updatedAt: "2026-09-06T12:00:00.000Z",
    });

    const res = await captureShotIdea(deps(), {
      sku: "HG-014",
      text: "on a lit shelf",
      origin: "proposed-then-edited",
      importId: "imp1",
      replaceThreadReply: true,
    });

    expect(res.applied).toBe(true);
    // The stale ask reply was deleted…
    const deletes = slack.postsOfKind("delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.ts).toBe("1700000000.000002");
    // …and a fresh threaded reply posted, rooted at the batch status post.
    const replies = slack.postsOfKind("sku-thread-reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.meta?.["threadTs"]).toBe("1700000000.000001");
    expect(replies[0]?.text).toContain("on a lit shelf");
    // No in-place `chat.update` of the (now-deleted) message on this path.
    expect(slack.postsOfKind("update")).toHaveLength(0);
    // The thread post row now points at the new message.
    expect(repo.getSkuThreadPost("imp1", "HG-014")?.slackTs).toBe(replies[0]?.ts);
  });

  it("is a no-op when there is no active Request for the SKU", async () => {
    const res = await captureShotIdea(deps(), {
      sku: "HG-999",
      text: "anything",
      origin: "slack-reply",
    });
    expect(res.applied).toBe(false);
    expect(res.ignoredReason).toBe("no-active-request");
  });

  it("is a no-op when the active Request isn't proposed (already confirmed / elsewhere)", async () => {
    repo.saveRequest(proposedRequest({ status: "confirmed" }));

    const res = await captureShotIdea(deps(), {
      sku: "HG-014",
      text: "a second idea",
      origin: "slack-reply",
    });

    expect(res.applied).toBe(false);
    expect(res.ignoredReason).toBe("not-proposed");
    expect(repo.getRequest("r1")?.shotIdeaText).not.toBe("a second idea");
  });

  it("is a no-op for blank / whitespace-only text", async () => {
    repo.saveRequest(proposedRequest());

    const res = await captureShotIdea(deps(), {
      sku: "HG-014",
      text: "   ",
      origin: "slack-reply",
    });

    expect(res.applied).toBe(false);
    expect(res.ignoredReason).toBe("blank-text");
    expect(repo.getRequest("r1")?.status).toBe("proposed");
  });

  it("swallows a thrown Slack update — the Request is already confirmed and durable", async () => {
    repo.saveImport({
      id: "imp1",
      receivedAt: "2026-09-06T12:00:00.000Z",
      sourceRef: "F_TEST",
      contentHash: "h1",
      rowCount: 1,
      nWithIdea: 0,
      nBlank: 1,
      nDone: 0,
    });
    repo.saveCatalogImportRow("imp1", "HG-014");
    repo.saveRequest(proposedRequest());
    repo.saveSkuThreadPost({
      importId: "imp1",
      sku: "HG-014",
      slackChannel: "C_TEST",
      slackTs: "1700000000.000001",
      stage: "ask",
      requestId: null,
      proposedText: proposedRequest().shotIdeaText,
      updatedAt: "2026-09-06T12:00:00.000Z",
    });
    slack.failNext("update");

    const res = await captureShotIdea(deps(), {
      sku: "HG-014",
      text: "on a lit shelf",
      origin: "slack-reply",
      importId: "imp1",
    });

    expect(res.applied).toBe(true);
    expect(repo.getRequest("r1")?.status).toBe("confirmed");
  });
});
