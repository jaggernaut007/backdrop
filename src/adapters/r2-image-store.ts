/**
 * `ImageStore` backed by Cloudflare R2 (ADR 0017). `putFromUrl` downloads the provider's
 * (expiring, presigned) image URL and uploads the bytes to `s3://bucket/<filename>`;
 * `urlFor` builds a public URL from `${R2_PUBLIC_BASE}/<filename>`.
 *
 * R2 is S3-compatible; we use the AWS SDK v3 client pointing at the R2 endpoint (usually
 * `{accountId}.r2.cloudflarestorage.com`). Public URLs can be served from R2's public domain
 * (`pub-*.r2.dev`, custom domain, or a Worker) — the port is agnostic.
 *
 * Rate limits: `pub-*.r2.dev` is a *development* domain and Cloudflare rate-limits it (see
 * ADR 0017 "r2.dev rate limits"). Our defence is aggressive edge caching — every object is
 * written `immutable` with a one-year TTL so Cloudflare's cache serves virtually all reads
 * (Slack's link unfurl re-fetches, browser opens, team re-views) without a request ever
 * reaching the bucket. This is safe because our filenames are content-stable: draft/final
 * names carry the attempt id and a `styled-NN` republish is an idempotent same-bytes
 * overwrite. For a production / client-facing deployment, attach a custom domain to the
 * bucket (no r2.dev rate limit) — a config-only change, `R2_PUBLIC_BASE_URL` is the only knob.
 *
 * Covered by `test/adapters/r2-image-store.test.ts` (stubbed `fetch` + mocked S3 client).
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import type { ImageStore } from "../ports/image-store.js";

/** Luma output is 2048px (~a few MB). Anything past this is not our image — don't buffer it. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Node's `fetch` has no default timeout; a hung download would wedge the job-loop tick. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/**
 * One year, `immutable`: keeps repeat reads on Cloudflare's edge so they never count against the
 * `pub-*.r2.dev` rate limit (ADR 0017). Filenames are content-stable, so no revalidation is
 * needed. Also used by the backfill script (`migrate-images-to-r2.ts`) so migrated bytes match.
 */
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export class R2ImageStore implements ImageStore {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly publicBaseUrl: string;

  constructor(config: Config) {
    if (!config.r2) {
      throw new Error(
        "R2ImageStore requires r2 config; check config.r2 is populated",
      );
    }

    const { bucket, endpoint, accessKeyId, secretAccessKey } = config.r2;

    this.s3Client = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.bucketName = bucket;
    this.publicBaseUrl = config.r2.publicBaseUrl.replace(/\/+$/, "");
  }

  async putFromUrl(filename: string, sourceUrl: string): Promise<string> {
    // Never let a caller-supplied name escape the bucket.
    const safeName = filename.split("/").pop();
    if (!safeName || safeName === "." || safeName === "..") {
      throw new Error(`invalid image filename: ${JSON.stringify(filename)}`);
    }

    const res = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `image download failed: HTTP ${res.status} for ${sourceUrl}`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(
        `refusing to store a non-image payload (content-type: ${contentType})`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error(`image download returned 0 bytes for ${sourceUrl}`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `image at ${sourceUrl} is ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES}-byte ceiling`,
      );
    }

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: safeName,
          Body: bytes,
          ContentType: contentType || "application/octet-stream",
          CacheControl: IMAGE_CACHE_CONTROL,
        }),
      );
    } catch (err) {
      throw new Error(
        `failed to upload ${safeName} to R2: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.urlFor(safeName);
  }

  urlFor(filename: string): string {
    const safeName = filename.split("/").pop();
    return `${this.publicBaseUrl}/${safeName}`;
  }
}
