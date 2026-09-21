/**
 * One-shot backfill: copy every image already on the Railway volume (`${DATA_DIR}/images/*`) into
 * the R2 bucket, then rewrite the two DB columns that persist a hosted URL
 * (`generation_attempts.result_image_url`, `published_images.stable_url`) from the old
 * `${PUBLIC_BASE_URL}/img/<name>` form to the R2 public URL.
 *
 * Idempotent: re-uploading overwrites the same key, and the URL rewrite only touches rows still
 * pointing at `/img/`. Safe to run repeatedly (e.g. after a partial failure).
 *
 * Run once, locally, with the volume contents present and R2 env vars set:
 *   IMAGE_STORE=r2 R2_BUCKET=... R2_ENDPOINT=... R2_ACCESS_KEY_ID=... \
 *   R2_SECRET_ACCESS_KEY=... R2_PUBLIC_BASE_URL=... DATA_DIR=./data \
 *   npm run migrate:images-to-r2
 *
 * The `/img/` route stays live in `runtime/http.ts` so any URL not yet rewritten keeps resolving
 * until this has run everywhere.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Database from "better-sqlite3";

import { IMAGE_CACHE_CONTROL } from "./adapters/r2-image-store.js";
import { loadConfig } from "./config.js";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.r2) {
    throw new Error(
      "set IMAGE_STORE=r2 and the R2_* env vars before running this backfill",
    );
  }

  const imagesDir = path.resolve(config.dataDir, "images");
  const dbPath = path.resolve(config.dataDir, "app.db");

  const s3 = new S3Client({
    region: "auto",
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  const publicBase = config.r2.publicBaseUrl.replace(/\/+$/, "");

  let files: string[] = [];
  try {
    files = (await readdir(imagesDir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`no images dir at ${imagesDir} — nothing to upload`);
    } else {
      throw err;
    }
  }

  console.log(`uploading ${files.length} file(s) from ${imagesDir} to r2://${config.r2.bucket}`);
  let uploaded = 0;
  for (const name of files) {
    const bytes = await readFile(path.join(imagesDir, name));
    const ext = path.extname(name).toLowerCase();
    await s3.send(
      new PutObjectCommand({
        Bucket: config.r2.bucket,
        Key: name,
        Body: bytes,
        ContentType: CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream",
        CacheControl: IMAGE_CACHE_CONTROL,
      }),
    );
    uploaded += 1;
    if (uploaded % 25 === 0) console.log(`  ${uploaded}/${files.length}`);
  }
  console.log(`uploaded ${uploaded} file(s)`);

  // --- rewrite persisted URLs -----------------------------------------------
  const db = new Database(dbPath);
  try {
    // `…/img/<name>`  ->  `${publicBase}/<name>` for every row still on the old host.
    const rewrite = (table: string, column: string): number => {
      const rows = db
        .prepare(
          `SELECT rowid, ${column} AS url FROM ${table} WHERE ${column} LIKE '%/img/%'`,
        )
        .all() as { rowid: number; url: string }[];
      const upd = db.prepare(
        `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`,
      );
      const tx = db.transaction((items: { rowid: number; url: string }[]) => {
        for (const { rowid, url } of items) {
          const filename = url.split("/img/").pop();
          if (!filename) continue;
          upd.run(`${publicBase}/${filename}`, rowid);
        }
      });
      tx(rows);
      return rows.length;
    };

    const a = rewrite("generation_attempts", "result_image_url");
    const p = rewrite("published_images", "stable_url");
    console.log(
      `rewrote ${a} generation_attempts + ${p} published_images URL(s) to ${publicBase}/`,
    );
  } finally {
    db.close();
  }

  console.log("migrate-images-to-r2: ok");
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((err) => {
    console.error("migrate-images-to-r2: failed", err);
    process.exit(1);
  });
}
