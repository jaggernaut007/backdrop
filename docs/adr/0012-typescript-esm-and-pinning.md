# 0012 — Exact version pinning, NodeNext ESM, and strict TypeScript

**Status:** Accepted · Wave 0

## Context

The build is AI-assisted under a one-day cap. Two failure modes to design out: (1) a dependency
minor/patch silently changing behaviour between the `docs/libraries/*.md` research and a later
`npm install`; (2) type-unsafe glue code (CSV row → domain mapping, optional Slack payload fields,
index access on parsed data) slipping through. The runtime is Node (26 local / 22 in the
container) running compiled ESM.

## Decision

- **Exact versions in `package.json` — no `^`, no `~`.** Every dependency and devDependency is
  pinned to the version its grounding doc was verified against. Upgrades are deliberate edits,
  re-checked against the docs. ADRs 0004 and 0005 cite this as the mechanism behind their calls.
- **ESM via `module`/`moduleResolution` = `NodeNext`**, `"type": "module"`, `verbatimModuleSyntax`
  + `isolatedModules` on. Relative imports carry the `.js` extension (TS source, JS on disk) so
  the emitted files run under Node's ESM resolver with no loader.
- **Strict TS set:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`.
- **Two tsconfigs:** `tsconfig.json` (src + test, `--noEmit`, for `typecheck`);
  `tsconfig.build.json` (src only, `rootDir: src`, emits `dist/`).

## Consequences

- Reproducible installs pinned to the researched versions; drift is a visible diff, not a silent
  `npm install`.
- `.js` import specifiers look odd but are the supported NodeNext form; `verbatimModuleSyntax`
  forces `import type` vs `import` to be explicit, which keeps `isolatedModules` / `tsx` happy.
- `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` catch the CSV / Slack-payload glue
  bugs at compile time; cost is more `?.` and explicit `| undefined` in the code (visible already
  in `palette.ts` and the fakes).
- A dependency upgrade is never automatic — a real cost if a security patch lands mid-build.

## Alternatives considered

- **Caret ranges + lockfile only** — the npm default; rejected because a fresh-checkout
  `npm install` could drift from the researched versions invisibly.
- **CommonJS** — simpler import specifiers, but `@slack/bolt` v5 and the ecosystem are ESM-first
  and the container runs ESM anyway.
- **A single tsconfig** — can't both type-check the tests and keep them out of `dist/`.
