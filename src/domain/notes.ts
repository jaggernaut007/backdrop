/**
 * The `Notes` column is one unstructured field doing five jobs (DOMAIN.md). This classifies the raw
 * string into `NotesInterpretation`. **Rule-based, not an LLM call** — deterministic, testable, and
 * biased toward false-negatives on `generationRisk` (ADR 0010 / ASSUMPTIONS.md A4: when unsure,
 * flag for a human, don't feed the prompt).
 *
 * Pipeline-acting fields: `priority` (queue order) and `generationRisk` (prompt caution). The other
 * three — `sourceAssetQuality`, `lifecycleConcern`, `bundlingIntent` — are surfaced for a human and
 * NEVER auto-acted.
 */
import type { NotesInterpretation } from "./types.js";

/** A Notes value often opens with a speaker tag (`El:`, `Amy:`, `Sam - `). Strip a short leading `word:` before matching. */
function stripSpeaker(raw: string): string {
  return raw.replace(/^\s*[A-Za-z][A-Za-z.]{0,15}\s*:\s*/, "").trim();
}

const PRIORITY = /\b(first|bestsell(?:er)?|top ?seller|priority|push)\b/i;
const GENERATION_RISK =
  /\b(careful|photographs? badly|too shiny|shiny|look premium|premium|matte|glare|reflect\w*)\b/i;
const SOURCE_QUALITY =
  /\b(underexposed|overexposed|out of focus|blurr\w*|grainy|low[- ]?res|washed[- ]?out|too dark|too bright)\b/i;
const LIFECYCLE =
  /\b(discontinu\w*|phas\w* out|end of life|eol|after spring|clearance|sunset\w*)\b/i;
const BUNDLING =
  /(shoot (?:with|together|alongside)|styled with|bundle\w*|\bw\/ the\b|with the (?:mugs|towels|set|blanket))/i;

/**
 * `"El: smoke glass photographs badly, careful"` →
 *   `{ priority: false, generationRisk: ["smoke glass photographs badly, careful"], … }`
 * `"El: bestseller, do this one first"` →
 *   `{ priority: true, generationRisk: [], … }`
 *
 * Never throws; always returns a complete interpretation.
 */
export function interpretNotes(raw: string): NotesInterpretation {
  const note = stripSpeaker(raw);
  return {
    priority: PRIORITY.test(note),
    generationRisk: GENERATION_RISK.test(note) ? [note] : [],
    sourceAssetQuality: SOURCE_QUALITY.test(note) ? note : null,
    lifecycleConcern: LIFECYCLE.test(note) ? note : null,
    bundlingIntent: BUNDLING.test(note) ? note : null,
  };
}
