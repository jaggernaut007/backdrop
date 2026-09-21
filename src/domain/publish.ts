/**
 * The deterministic published-image filename (ADR 0008). This name IS the identity of a
 * `PublishedImage` (DOMAIN.md): derived, stable, collision-free, and self-describing — it answers
 * "is this the final one?" without a Slack question, healing the `IMG_43xx` scar.
 *
 *   `${sku.toLowerCase()}-styled-${NN}.jpg`   NN = zero-padded two-digit pick order (01, 02, 03)
 *
 * SPEC F4 asserts the exact strings `hg-002-styled-01.jpg` / `hg-002-styled-02.jpg`. `.jpg` always
 * (the served extension the web person types), regardless of the bytes Luma returns. The sequence
 * is per-Request pick order; re-publishing a pick reuses its name (idempotent overwrite).
 */

/** Two digits of sequence ⇒ 99 picks max. Far past the 3 Finals a direction ever produces. */
export const PUBLISH_SEQUENCE_MAX = 99;

/**
 * Build the deterministic published-image filename for a picked Final.
 *
 * @param sku       the Request's SKU. Sanitised to a slug (`[^a-z0-9]+` → `-`, ends trimmed), so
 *                  `HG-002` → `hg-002` and a quirky SKU can't produce a name the image-store
 *                  adapter would then silently `basename`-strip.
 * @param sequence  1-based pick order within the Request (`1` → `-01`, `2` → `-02`).
 * @returns `${slug}-styled-${NN}.jpg` — `.jpg` always, regardless of the bytes Luma returns.
 * @throws Error if the SKU has no alphanumeric characters, or `sequence` is not an integer in
 *         `1..PUBLISH_SEQUENCE_MAX`.
 */
export function publishedFilename(sku: string, sequence: number): string {
  // Collapse anything that isn't a-z/0-9 to a single hyphen so the name is always a safe,
  // greppable path segment (real SKUs like `HG-002` are unaffected → `hg-002`). The image-store
  // adapter also strips path separators, but keeping the domain name clean means the stored
  // `PublishedImage.filename` and the hosted file always agree.
  const slug = sku
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new Error(
      `publishedFilename: SKU has no alphanumeric characters: ${JSON.stringify(sku)}`,
    );
  }
  if (
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence > PUBLISH_SEQUENCE_MAX
  ) {
    throw new Error(
      `publishedFilename: sequence must be an integer in 1..${PUBLISH_SEQUENCE_MAX}, got ${sequence}`,
    );
  }
  return `${slug}-styled-${String(sequence).padStart(2, "0")}.jpg`;
}
