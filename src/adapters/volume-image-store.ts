/**
 * `ImageStore` backed by the Railway volume (ADR 0007). `putFromUrl` downloads the provider's
 * (expiring, presigned) image URL and writes the bytes under `${DATA_DIR}/images/<filename>`;
 * `runtime/http` serves that directory at `GET /img/:filename`, so `urlFor` is
 * `${PUBLIC_BASE_URL}/img/<filename>`. Swapping to S3/R2 later is a single new adapter.
 *
 * Covered by `test/adapters/volume-image-store.test.ts` (stubbed `fetch` + a tmp dir).
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import type { Config } from "../config.js";
import type { ImageStore } from "../ports/image-store.js";

/** Luma output is 2048px (~a few MB). Anything past this is not our image — don't buffer it. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Node's `fetch` has no default timeout; a hung download would wedge the job-loop tick. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

export class VolumeImageStore implements ImageStore {
  private readonly imagesDir: string;
  private readonly publicBaseUrl: string;

  constructor(config: Config) {
    this.imagesDir = path.resolve(config.dataDir, "images");
    this.publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  }

  async putFromUrl(filename: string, sourceUrl: string): Promise<string> {
    // Never let a caller-supplied name escape the images dir.
    const safeName = path.basename(filename);
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
      // A presigned URL that has expired answers with XML/HTML, not an image — status can still be 200.
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

    await mkdir(this.imagesDir, { recursive: true });
    await writeFile(path.join(this.imagesDir, safeName), bytes);
    return this.urlFor(safeName);
  }

  urlFor(filename: string): string {
    return `${this.publicBaseUrl}/img/${path.basename(filename)}`;
  }

  async exists(filename: string): Promise<boolean> {
    const safeName = path.basename(filename);
    if (!safeName || safeName === "." || safeName === "..") {
      return false;
    }
    try {
      await access(path.join(this.imagesDir, safeName), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
