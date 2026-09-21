/**
 * Where published images live. DOMAIN.md / ASSUMPTIONS.md A3: the pipeline hands back a
 * deterministic filename and a STABLE URL from its own store; it never writes to the team's Drive.
 *
 * The store owns the fetch: Luma's `output[0].url` is a presigned URL that expires in ~1 hour
 * (docs/libraries/luma-vitest-railway.md §1.4), so the adapter downloads it and re-hosts under a
 * permanent name. Keeping the download inside the adapter is what lets every SPEC scenario run
 * without a real network — the fake just records the source URL.
 *
 * Wave-0/2 adapter writes to the Railway volume and serves via `GET /img/:filename`. The port
 * keeps an S3/R2 swap to a single adapter change.
 */
export interface ImageStore {
  /**
   * Download `sourceUrl` and persist its bytes under `filename` (e.g. `hg-002-styled-01.jpg`),
   * returning a stable, publicly-resolvable URL. Overwrites if the filename already exists (a
   * regenerated pick reuses its deterministic name). Throws if the download fails or returns a
   * non-image payload.
   */
  putFromUrl(filename: string, sourceUrl: string): Promise<string>;

  /** The stable URL a given filename resolves to, without a write. */
  urlFor(filename: string): string;

  /**
   * Check if the file bytes for a given filename are available (exist on disk / in storage).
   * Optional; default implementations may return true (assume all published files exist, e.g. for
   * cloud storage). Synchronous for local volume stores, async for consistency with putFromUrl.
   */
  exists?(filename: string): Promise<boolean>;
}
