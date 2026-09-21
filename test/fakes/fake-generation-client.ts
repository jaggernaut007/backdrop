import type {
  GenerationClient,
  GenerationHandle,
  GenerationResult,
} from "../../src/ports/generation-client.js";
import type { GenerationQuality } from "../../src/domain/types.js";

export interface RecordedCreate {
  prompt: string;
  sourceImageUrl: string;
  quality: GenerationQuality;
  generationId: string;
}

/**
 * Records every create() call (prompt, quality) so scenario tests can assert what was asked of
 * the model. Completes synchronously by default: each create() yields an id whose get() returns
 * `completed` with a deterministic fake image URL.
 *
 * Use `failGeneration(id)` (one id) or `failEverything()` (all) to drive GenerationFailed paths,
 * and `enableManualCompletion()` + `markComplete(id)` to hold a generation in `processing`.
 * `get()` on an id that was never returned by `create()` throws — real Luma 404s, and a use-case
 * that persisted the wrong generation id should fail, not silently "complete".
 */
export class FakeGenerationClient implements GenerationClient {
  readonly creates: RecordedCreate[] = [];
  private seq = 0;
  private known = new Set<string>();
  private failAll = false;
  private failIds = new Set<string>();
  /** get() reports `completed` for these, but with `imageUrl: null` — the real adapter can too
   *  (empty `output` array), and `resolvePendingGenerations` treats it as a failure. */
  private noImageIds = new Set<string>();
  /** If set, get() reports `processing` until markComplete(id) is called. */
  private pending = new Set<string>();
  private manualMode = false;

  async create(input: {
    prompt: string;
    sourceImageUrl: string;
    quality: GenerationQuality;
  }): Promise<GenerationHandle> {
    this.seq += 1;
    const id = `gen_${this.seq}`;
    this.known.add(id);
    this.creates.push({ ...input, generationId: id });
    if (this.manualMode) this.pending.add(id);
    return { id, state: this.manualMode ? "processing" : "queued" };
  }

  async get(generationId: string): Promise<GenerationResult> {
    if (!this.known.has(generationId)) {
      throw new Error(
        `FakeGenerationClient: get() for unknown generation id ${generationId} (real Luma returns 404)`,
      );
    }
    if (this.failAll || this.failIds.has(generationId)) {
      return {
        id: generationId,
        state: "failed",
        imageUrl: null,
        failureReason: "fake failure",
        failureCode: "generation_failed",
      };
    }
    if (this.pending.has(generationId)) {
      return {
        id: generationId,
        state: "processing",
        imageUrl: null,
        failureReason: null,
        failureCode: null,
      };
    }
    if (this.noImageIds.has(generationId)) {
      return {
        id: generationId,
        state: "completed",
        imageUrl: null,
        failureReason: null,
        failureCode: null,
      };
    }
    return {
      id: generationId,
      state: "completed",
      imageUrl: `https://fake-luma.test/out/${generationId}.png?X-Amz-Expires=3600`,
      failureReason: null,
      failureCode: null,
    };
  }

  // --- test controls -------------------------------------------------------
  /** After this, get() never auto-completes; call markComplete(id) explicitly. */
  enableManualCompletion(): void {
    this.manualMode = true;
  }
  markComplete(generationId: string): void {
    this.pending.delete(generationId);
  }
  failGeneration(generationId: string): void {
    this.failIds.add(generationId);
  }
  failEverything(): void {
    this.failAll = true;
  }
  /** After this, get(id) reports `completed` with no image URL. */
  completeWithoutImage(generationId: string): void {
    this.noImageIds.add(generationId);
  }
  get createCount(): number {
    return this.creates.length;
  }
}
