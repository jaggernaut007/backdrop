import type { GenerationQuality } from "../domain/types.js";

/**
 * The Luma model, behind one adapter (DOMAIN.md: "the Luma model — called through one adapter").
 * A model swap touches only the adapter. See docs/libraries/luma-vitest-railway.md.
 */

export type GenerationState = "queued" | "processing" | "completed" | "failed";

export interface GenerationHandle {
  /** Provider-side generation id, to poll with `get`. */
  readonly id: string;
  readonly state: GenerationState;
}

export interface GenerationResult {
  readonly id: string;
  readonly state: GenerationState;
  /**
   * On `completed`: the provider's output image URL. This is a presigned URL that
   * EXPIRES IN ~1 HOUR — callers must download + re-host immediately (ImageStore).
   */
  readonly imageUrl: string | null;
  /** On `failed`: a legible reason for the digest / Slack, plus a machine code. */
  readonly failureReason: string | null;
  readonly failureCode: string | null;
}

export interface GenerationClient {
  /**
   * Kick off an image_edit generation from the product's white-background photo.
   * `quality` picks the model: draft → uni-1 (cheap), final → uni-1-max (full quality).
   */
  create(input: {
    prompt: string;
    sourceImageUrl: string;
    quality: GenerationQuality;
  }): Promise<GenerationHandle>;

  /** Poll a generation. Terminal states are `completed` and `failed`. */
  get(generationId: string): Promise<GenerationResult>;
}
