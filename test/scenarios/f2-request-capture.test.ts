/**
 * F2 — Request capture. Scenario names are SPEC.md verbatim.
 *
 * `ingestCatalog` opens a Request directly for a row that already has a Shot Idea (Wave 1
 * behaviour, pinned here as its own F2 scenario) and a `proposed` Request + one Slack ask — posted
 * as that SKU's living reply in the batch's thread (F7 / ADR 0019) — for a blank row;
 * `captureShotIdea` confirms the blank-row Request via either button path (`proposed` /
 * `proposed-then-edited` — `slack-reply` has no runtime entry point post-Wave-7). Slack is faked at
 * the port boundary; the Bolt runtime (button/modal plumbing) is exercised manually, not here — see
 * `runtime/slack-events.ts`'s file header.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { captureShotIdea } from "../../src/app/capture-shot-idea.js";
import { ingestCatalog } from "../../src/app/ingest-catalog.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

describe("F2 — Request capture", () => {
  let repo: InMemoryRepository;
  let slack: FakeSlackGateway;
  let clock: FakeClock;

  const deps = () => ({ repo, slack, clock });

  const csvOf = (rows: string[]): string =>
    [
      "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes",
      ...rows,
    ].join("\n");

  beforeEach(() => {
    repo = new InMemoryRepository();
    slack = new FakeSlackGateway();
    clock = new FakeClock("2026-09-06T12:00:00.000Z");
  });

  it("A row that already carries a Shot Idea opens a Request directly", async () => {
    const csv = csvOf([
      'HG-002,Stoneware Mug 12oz,Ceramics,Sage,Stoneware,$28,https://x/hg-002.jpg,"morning kitchen counter, steam, warm light",',
    ]);

    await ingestCatalog(deps(), { csv, sourceRef: "F_TEST" });

    const request = repo.getActiveRequestForSku("HG-002");
    expect(request?.status).toBe("confirmed");
    expect(request?.shotIdeaText).toBe(
      "morning kitchen counter, steam, warm light",
    );
    expect(request?.ideaRevision).toBe(1);
    expect(request?.shotIdeaOrigin).toBe("sheet");
  });

  it("A blank row gets the ask and a proposal in one message", async () => {
    const csv = csvOf([
      "HG-014,Table Runner,Textiles,Clay Pink Charcoal,Linen,$42,https://x/hg-014.jpg,,",
    ]);

    const result = await ingestCatalog(deps(), { csv, sourceRef: "F_TEST" });

    // The batch status post went up first, then the ask as HG-014's living thread reply under it.
    const batchPosts = slack.postsOfKind("batch-status");
    expect(batchPosts).toHaveLength(1);

    const asks = slack.postsOfKind("blank-row-ask");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.meta?.["sku"]).toBe("HG-014");
    expect(asks[0]?.meta?.["importId"]).toBe(result.importId);
    expect(asks[0]?.meta?.["threadTs"]).toBe(batchPosts[0]?.ts);
    const proposedText = asks[0]?.meta?.["proposedText"] as string;
    expect(proposedText).toContain("Clay");
    expect(proposedText).toContain("Linen");
    expect(proposedText).toContain("Textiles");

    // No Request is confirmed for that SKU yet.
    expect(repo.getActiveRequestForSku("HG-014")?.status).toBe("proposed");

    // The living thread reply is durably recorded (`stage: "ask"`), correlated to this batch.
    const thread = repo.getSkuThreadPost(result.importId, "HG-014");
    expect(thread?.stage).toBe("ask");
    expect(thread?.proposedText).toBe(proposedText);
  });

  it("An accepted proposal (unedited) becomes the Shot Idea, origin proposed", async () => {
    const csv = csvOf([
      "HG-014,Table Runner,Textiles,Clay Pink Charcoal,Linen,$42,https://x/hg-014.jpg,,",
    ]);
    const result = await ingestCatalog(deps(), { csv, sourceRef: "F_TEST" });
    const proposedText = repo.getSkuThreadPost(result.importId, "HG-014")
      ?.proposedText as string;

    const res = await captureShotIdea(
      { repo, gateway: slack, clock },
      {
        sku: "HG-014",
        text: proposedText,
        origin: "proposed",
        importId: result.importId,
      },
    );

    expect(res.applied).toBe(true);
    const request = repo.getActiveRequestForSku("HG-014");
    expect(request?.status).toBe("confirmed");
    expect(request?.shotIdeaText).toBe(proposedText);
    expect(request?.shotIdeaOrigin).toBe("proposed");
  });

  it("An edited proposal becomes the Shot Idea", async () => {
    const csv = csvOf([
      "HG-014,Table Runner,Textiles,Clay Pink Charcoal,Linen,$42,https://x/hg-014.jpg,,",
    ]);
    const result = await ingestCatalog(deps(), { csv, sourceRef: "F_TEST" });
    const proposedText = repo.getSkuThreadPost(result.importId, "HG-014")
      ?.proposedText as string;

    const res = await captureShotIdea(
      { repo, gateway: slack, clock },
      {
        sku: "HG-014",
        text: `${proposedText} — closer crop, morning light`,
        origin: "proposed-then-edited",
        importId: result.importId,
      },
    );

    expect(res.applied).toBe(true);
    const request = repo.getActiveRequestForSku("HG-014");
    expect(request?.status).toBe("confirmed");
    expect(request?.shotIdeaText).toBe(
      `${proposedText} — closer crop, morning light`,
    );
    expect(request?.shotIdeaOrigin).toBe("proposed-then-edited");
  });

  // Not a named SPEC scenario — pins that a blank row's `proposed` Request inherits the same
  // Notes-derived priority as a confirmed one (ingest-catalog.ts computes `notes` once per row).
  it("a Notes priority also lifts a blank row's proposed Request", async () => {
    const csv = csvOf([
      'HG-014,Table Runner,Textiles,Clay Pink Charcoal,Linen,$42,https://x/hg-014.jpg,,"El: bestseller, do this one first"',
    ]);

    await ingestCatalog(deps(), { csv, sourceRef: "F_TEST" });

    expect(repo.getActiveRequestForSku("HG-014")?.priorityRank).toBeGreaterThan(0);
  });
});
