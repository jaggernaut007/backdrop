import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ingestCatalog } from "../../src/app/ingest-catalog.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { FakeSlackGateway } from "../fakes/fake-slack-gateway.js";
import { InMemoryRepository } from "../fakes/in-memory-repository.js";

const HEADER =
  "SKU,Product Name,Category,Color / Finish,Material,Price,Photo,Shot Idea,Notes";

const csvOf = (rows: { sku: string; idea: string; price: number }[]): string =>
  [
    HEADER,
    ...rows.map(
      (r) =>
        `${r.sku},Item ${r.sku},Ceramics,Sage,Stoneware,$${r.price},https://x/${r.sku}.jpg,"${r.idea}",`,
    ),
  ].join("\n");

const totalRequests = (repo: InMemoryRepository): number =>
  repo
    .listProducts()
    .reduce((n, p) => n + repo.listRequestsForSku(p.sku).length, 0);

describe("F1 — ingest idempotency (property)", () => {
  it("a second ingest opens no more Products or Requests than the first — identical OR re-listed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            sku: fc
              .integer({ min: 1, max: 20 })
              .map((n) => `HG-${String(n).padStart(3, "0")}`),
            idea: fc.constantFrom("a lit shelf", "a set table", ""),
            price: fc.integer({ min: 10, max: 200 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.boolean(),
        async (rawRows, reListWithBumpedPrice) => {
          const rows = [...new Map(rawRows.map((r) => [r.sku, r])).values()]; // one row per SKU
          const deps = {
            repo: new InMemoryRepository(),
            slack: new FakeSlackGateway(),
            clock: new FakeClock("2026-09-06T12:00:00.000Z"),
          };

          await ingestCatalog(deps, { csv: csvOf(rows), sourceRef: "a" });
          const products = deps.repo.listProducts().length;
          const requests = totalRequests(deps.repo);

          const second = reListWithBumpedPrice
            ? csvOf(rows.map((r) => ({ ...r, price: r.price + 1 }))) // new hash -> row loop path
            : csvOf(rows); // byte-identical -> content-hash short-circuit
          const res = await ingestCatalog(deps, {
            csv: second,
            sourceRef: "b",
          });

          expect(deps.repo.listProducts().length).toBe(products);
          expect(totalRequests(deps.repo)).toBe(requests);
          expect(res.requestsOpened).toBe(0);
        },
      ),
    );
  });
});
