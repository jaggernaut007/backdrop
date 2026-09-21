/**
 * DB migration. Called from `main.ts` on every boot (the Railway volume mounts at runtime, not
 * build, so migrations cannot run in a pre-deploy step — docs/libraries/luma-vitest-railway.md
 * §3.2). Also runnable standalone via `npm run migrate`.
 *
 * Ensures the data + images directories exist on the volume, then creates the SQLite schema
 * (`SqliteRepository.migrate()` — idempotent `CREATE TABLE IF NOT EXISTS`).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteRepository } from "./adapters/sqlite-repository.js";

export function runMigrations(dataDir = process.env.DATA_DIR ?? "data"): void {
  const root = path.resolve(dataDir);
  for (const dir of [root, path.join(root, "images")]) {
    mkdirSync(dir, { recursive: true });
  }
  const repo = new SqliteRepository(path.join(root, "app.db"));
  try {
    repo.migrate();
  } finally {
    repo.close();
  }
}

// Run when invoked directly (`node dist/migrate.js` / `tsx src/migrate.ts`), not when imported.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runMigrations();
  console.log("migrate: ok");
}
