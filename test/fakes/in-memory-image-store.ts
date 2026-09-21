import type { ImageStore } from "../../src/ports/image-store.js";

export interface StoredImage {
  filename: string;
  sourceUrl: string;
  url: string;
}

/**
 * Records what was published without touching the network or disk. `putFromUrl` returns a stable
 * `${baseUrl}/img/${filename}` and remembers the source URL so a scenario can assert the pipeline
 * re-hosted Luma's (expiring) output rather than passing it through.
 */
export class InMemoryImageStore implements ImageStore {
  readonly stored: StoredImage[] = [];
  private failUrls = new Set<string>();

  constructor(private readonly baseUrl = "https://pipeline.test") {}

  async putFromUrl(filename: string, sourceUrl: string): Promise<string> {
    if (this.failUrls.has(sourceUrl)) {
      throw new Error(
        `InMemoryImageStore: simulated download failure for ${sourceUrl}`,
      );
    }
    const url = this.urlFor(filename);
    // last-writer-wins on filename (a regenerated pick reuses its deterministic name)
    const existing = this.stored.findIndex((s) => s.filename === filename);
    const entry = { filename, sourceUrl, url };
    if (existing >= 0) this.stored[existing] = entry;
    else this.stored.push(entry);
    return url;
  }

  urlFor(filename: string): string {
    return `${this.baseUrl}/img/${filename}`;
  }

  // --- test controls -------------------------------------------------------
  failDownloadOf(sourceUrl: string): void {
    this.failUrls.add(sourceUrl);
  }
  filenames(): string[] {
    return this.stored.map((s) => s.filename);
  }
}
