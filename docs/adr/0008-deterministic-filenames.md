# 0008 — Deterministic published-image filename scheme

**Status:** Accepted · Wave 0

## Context

The `IMG_43xx.jpg` incident: the web person shipped the wrong camera-named file to a live product
page and nobody noticed for three weeks. DOMAIN.md `PublishedImage` invariant: "name is derived,
stable, and collision-free ... answers 'is this the final one?' without a Slack question." SPEC F4
asserts the exact strings `hg-002-styled-01.jpg` and `hg-002-styled-02.jpg`.

## Decision

Published filename = **`${sku.toLowerCase()}-styled-${NN}.jpg`**, where `NN` is a zero-padded
two-digit sequence (`01`, `02`, `03`) assigned in pick order within a Request. `.jpg` always.
Computed by a pure function in `src/domain/publish.ts`; it is the `PublishedImage` identity.

## Consequences

- The filename is a function of SKU + pick order — reproducible, greppable, and self-describing.
  The SKU is first sanitised to an `[a-z0-9-]` slug (`HG-002` → `hg-002`; throws if nothing
  alphanumeric survives), so a quirky SKU can't produce a name the image-store adapter would then
  silently `basename`-strip. Re-publishing a pick overwrites the same name (idempotent).
- Two picks → `hg-002-styled-01.jpg`, `hg-002-styled-02.jpg`. Matches SPEC F4 verbatim.
- Sequence is per-Request; a later idea revision for the same SKU would restart at `01` and
  overwrite — acceptable because superseding revisions are out of scope this build (SCOPE.md cut),
  and flagged if it ever matters. `published_images.filename` is the global PRIMARY KEY, so that
  overwrite also _moves_ the row's `request_id` to the new Request (the old one silently drops a
  published image while still reading `done`). Closing that needs a `(request_id, filename)` key —
  deferred with the rest of superseding-revision support. `handle-pick` assigns the next sequence
  as `max(existing) + 1`, not `count + 1`, so it is already robust to a gap if one ever appears.
- Cost accepted: no content hash in the name, so a client can't treat it as immutable — hence the
  non-`immutable` cache header ([0007](0007-app-served-images.md)).

## Alternatives considered

- **Keep the Luma/generation id in the name** — stable but not human-meaningful; reintroduces
  "which one is final?".
- **Content-hash filenames** — cache-immutable, but opaque to the web person and changes every
  regeneration. The scar is about *meaning*, not collisions.
