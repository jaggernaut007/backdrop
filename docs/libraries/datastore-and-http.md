# Grounding: datastore + HTTP (`better-sqlite3`, `fastify`, `@fastify/static`, `csv-parse`)

Verified against `registry.npmjs.org` and official docs, 2026-09-06. Reference for
`src/adapters/sqlite-repository.ts`, `src/runtime/http.ts`, and the CSV parsing in
`src/app/ingest-catalog.ts`.

---

## 1. better-sqlite3

**Version pinned: `better-sqlite3@13.0.3`** (2026-08-05). Dev dep: **`@types/better-sqlite3@7.6.x`**
(the package ships no types).

### Node support / native module

- `engines.node`: `>=22`. Runtime dep `node-addon-api@^8`; **v13.0.0 rewrote the addon on N-API**,
  so prebuilt binaries are keyed to the N-API ABI, not a Node version — **one prebuilt works across
  Node 22, 24, 25, 26**. Prebuilts published per platform/arch/libc: `linux-x64`, `linux-arm64`,
  `linuxmusl-*`, `darwin-*`, `win32-*`.
- v13 removed `prebuild-install`; prebuilts ship **inside the package**. On `npm install`, a
  matching prebuilt is used directly — **no compile**. `node:22-bookworm` is glibc → the
  `linux-x64`/`linux-arm64` prebuilt applies and the build step is not exercised.
- Keep a toolchain in the Dockerfile only as fallback:
  `apt-get install -y --no-install-recommends python3 make g++`. better-sqlite3 bundles the SQLite
  amalgamation (3.53.4) → no `libsqlite3-dev`.
- Multi-stage: install in the builder and copy `node_modules` to a runtime stage on the **same
  base OS/libc**, or the `.node` binary won't load.

### API

```ts
import Database from 'better-sqlite3';

const db = new Database('data/app.db');   // ':memory:' for tests; directory must exist
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);

const insert = db.prepare('INSERT INTO items (name) VALUES (?)');
insert.run('Widget');                     // -> { changes: 1, lastInsertRowid: 1 }

db.prepare('SELECT * FROM items WHERE id = ?').get(1);          // row | undefined
db.prepare('SELECT * FROM items WHERE name = @n').all({ n: 'Widget' }); // row[]
for (const r of db.prepare('SELECT * FROM items').iterate()) { /* streaming */ }

const insertMany = db.transaction((batch: string[]) => {
  for (const n of batch) insert.run(n);   // auto BEGIN/COMMIT, auto ROLLBACK on throw
});
insertMany(['A', 'B']);                    // .deferred / .immediate / .exclusive variants exist

db.close();                                // on shutdown
```

**All calls are synchronous** — the repository port has no `async`/`await`. Named params
`@name` / `:name` / `$name`; positional `?`.

### Why not `node:sqlite`

`node:sqlite` (built in, zero deps, zero native build) is still **Stability 1.2 — Release
Candidate** on the Node 26 releases shipping now, and has **no `.transaction()` helper** (manual
`BEGIN`/`COMMIT`/`ROLLBACK` + savepoints). better-sqlite3 v13's N-API prebuilts remove most of the
"native module pain" for server deploys. → **use `better-sqlite3@13.0.3` now**; revisit `node:sqlite`
when it reaches Stability 2. (See ADR 0004.)

Docs: <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md> · <https://nodejs.org/docs/latest/api/sqlite.html>

---

## 2. fastify

**Version pinned: `fastify@5.12.3`** (Sept 2026). v5 supports **Node ≥ 20** (dropped 18). No
published upper bound; running on Node 26 is expected to work (ahead of the doc table).

```ts
import Fastify from 'fastify';

const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: '0.0.0.0' });   // '0.0.0.0' REQUIRED in a container
```

### Graceful shutdown

```ts
async function shutdown(signal: string) {
  try { await app.close(); process.exit(0); }   // stops accepting, drains, runs onClose hooks
  catch (err) { app.log.error(err); process.exit(1); }
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void shutdown(sig));
app.addHook('onClose', async () => { db.close(); });
```

Ensure Node runs as PID 1 with signal forwarding (`exec`-form `CMD`, or `--init`/`tini`) or
`SIGTERM` never reaches it. `close-with-grace` (Fastify org) adds a hard timeout if a drain stalls.

---

## 3. @fastify/static

**Version pinned: `@fastify/static@10.1.3`** (requires Fastify v5).

```ts
import fastifyStatic from '@fastify/static';
import path from 'node:path';

await app.register(fastifyStatic, {
  root: path.resolve(process.env.DATA_DIR ?? 'data', 'images'),  // ABSOLUTE path required
  prefix: '/img/',                                               // GET /img/x.jpg -> <root>/x.jpg
  index: false,
  list: false,
  // `src/runtime/http.ts` uses the option form (not the setHeaders callback) — the v10.1.3
  // callback type is mistyped as FastifyReply, which fails typecheck:
  cacheControl: true,
  maxAge: '1d',        // matches ADR 0007 — 1 day, NOT immutable (a regenerated pick reuses its name)
  immutable: false,
});
```

- `root` must be absolute (or an array of absolute paths). Path traversal outside `root` is blocked.
- Registering the plugin more than once: pass `decorateReply: false` on all but the first.
- `immutable: true` only with content-hashed filenames (our names are stable but not hashed — a
  regenerated image reuses the filename, so **don't** send `immutable`).

Docs: <https://github.com/fastify/fastify-static>

---

## 4. csv-parse

**Version pinned: `csv-parse@7.0.2`** (2026-08-02). Zero deps, **types bundled** (no `@types`).

```ts
import { parse } from 'csv-parse/sync';

const records = parse(buffer, {   // input: string | Buffer (Buffer accepted directly)
  columns: true,                  // header row -> object keys; each record is Record<string,string>
  skip_empty_lines: true,
  trim: true,                     // trims around the delimiter, NOT inside quotes
  bom: true,                      // strip a UTF-8 BOM (spreadsheet exports often have one)
  relax_column_count: true,       // tolerate short trailing rows -> fill missing cols with ''
});
```

Behaviour on the catalog's quirks (`data/catalog.csv`):

- **Quoted field with commas** — handled by default. `"El: bestseller, do this one first"` →
  the single value `El: bestseller, do this one first` (quotes stripped, interior `,` and `:`
  kept). With `trim: true`, whitespace **inside** the quotes is preserved.
- **Leading `$`** — no special handling; `$48` comes back as the string `"$48"` (no casting by
  default). `src/domain/price.ts` does `"$48" -> 4800`.
- **Empty trailing column** — `notes: ''` (empty string, every declared column present). Without
  `relax_column_count`, a row with **fewer** fields than the header throws
  `CSV_RECORD_INCONSISTENT_FIELDS_LENGTH` — hence `relax_column_count: true`.
- `columns: true` maps the header row to keys — confirmed.

Alternative considered: PapaParse 5.x (needs `@types/papaparse`, prefers string over Buffer,
thinner Node streaming). Not switching — csv-parse is already dependency-free, typed, and correct
on every edge case above.

Docs: <https://csv.js.org/parse/api/sync/> · <https://csv.js.org/parse/options/>
