/**
 * `GenerationPrompt` composition — the judgment step (DOMAIN.md: "not a string copy of the Shot
 * Idea"). Pure. Given the confirmed Shot Idea, the Product's facts, its `ColorSet`, and any
 * `generationRisk` flags parsed from `Notes`, produce the single prompt string handed to Luma's
 * `image_edit` (SPEC F3a scenario 1: "a GenerationPrompt is composed from the Shot Idea plus the
 * Product's ColorSet and the risk flag").
 *
 * On a retry the reject-reason chip is carried forward verbatim (SPEC F3b: "a GenerationPrompt that
 * carries the `color off` reason forward"). `runDraft` passes a first draft (`retryReason` unset);
 * `retryDraft` (Wave 5) passes the chip from the most recent Reject Decision.
 */
import type { ColorSet, RejectReason } from "./types.js";

/** Luma `image_edit` enforces `prompt` ∈ [1, 6000] chars (docs/libraries/luma-vitest-railway.md §1.3). */
export const MAX_PROMPT_CHARS = 6000;

export interface ComposePromptInput {
  readonly shotIdea: string;
  readonly category: string;
  readonly material: string;
  readonly colorSet: ColorSet;
  /** `NotesInterpretation.generationRisk` — cautions, entered verbatim (ASSUMPTIONS.md A4). */
  readonly riskFlags: readonly string[];
  /** Set only on a retry: the chip the previous Draft drew, carried forward (SPEC F3b). */
  readonly retryReason?: RejectReason | null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Compose the prompt. Sections are dropped when empty, so a blank `Material` or an all-unmatched
 * `ColorSet` just omits its line rather than emitting `Product: , .`. Throws if the result would
 * exceed Luma's 6000-char ceiling — a caller passing a pathological Shot Idea should fail at
 * composition, not get a 400 from the API mid-pipeline.
 */
export function composeGenerationPrompt(input: ComposePromptInput): string {
  const lines: string[] = [
    "Editorial lifestyle product photograph for an e-commerce catalog.",
    "Keep the product from the source image exactly as it is — same shape, proportions, material, and markings. Restyle only the scene around it.",
    `Scene: ${collapse(input.shotIdea)}`,
  ];

  const product = [input.category, input.material]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
  if (product) lines.push(`Product: ${product}.`);

  if (input.colorSet.matched.length > 0) {
    lines.push(`Hold the brand palette: ${input.colorSet.matched.join(", ")}.`);
  }
  if (input.colorSet.unmatched.length > 0) {
    lines.push(
      `Other described tones: ${input.colorSet.unmatched.join(", ")}.`,
    );
  }

  for (const flag of input.riskFlags) {
    const caution = collapse(flag);
    if (caution) lines.push(`Caution: ${caution}.`);
  }

  if (input.retryReason) {
    lines.push(
      `This is a second attempt. The previous Draft was rejected as "${input.retryReason}" — change the styling to address that specifically.`,
    );
  }

  const prompt = lines.join("\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `composed prompt is ${prompt.length} chars, over the ${MAX_PROMPT_CHARS}-char Luma limit`,
    );
  }
  return prompt;
}
