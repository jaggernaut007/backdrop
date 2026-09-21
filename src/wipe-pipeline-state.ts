#!/usr/bin/env node
/**
 * Wipe all mutable pipeline state from the SQLite database, preserving the schema.
 * Run only via `npm run wipe:pipeline` in a deployment context.
 *
 * Guarded by a required `--yes` flag to prevent accidental execution.
 * Deletes rows from every mutable table in FK-safe order.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = process.env.DATA_DIR || "./data";
const dbPath = path.join(dataDir, "app.db");
const yesFlag = process.argv.includes("--yes");

if (!yesFlag) {
  console.error("⚠ Cowardly refusing to wipe without --yes flag");
  console.error("Usage: node dist/wipe-pipeline-state.js --yes");
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error(`✗ Database not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

const tables = [
  "decisions",
  "review_posts",
  "published_images",
  "generation_attempts",
  "sku_thread_posts",
  "batch_status_posts",
  "catalog_import_rows",
  "blank_row_asks",
  "shot_requests",
  "catalog_imports",
  "products",
];

let totalRows = 0;

try {
  for (const table of tables) {
    const result = db.prepare(`DELETE FROM ${table}`).run();
    const count = result.changes;
    totalRows += count;
    console.log(`  ${table}: ${count} rows deleted`);
  }

  // Compact the database.
  db.prepare("VACUUM").run();

  console.log(`\n✅ Wiped ${totalRows} rows total. Database vacuumed.`);
  process.exit(0);
} catch (err) {
  console.error(`✗ Failed to wipe pipeline state: ${err}`);
  process.exit(1);
} finally {
  db.close();
}
