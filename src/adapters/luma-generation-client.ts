/**
 * `GenerationClient` over the Luma Agents REST API via `fetch` — no SDK (ADR 0005;
 * docs/libraries/luma-vitest-railway.md §1). Two calls: `POST /generations` (type `image_edit`)
 * and `GET /generations/{id}` for polling. `uni-1` for a Draft, `uni-1-max` for a Final.
 *
 * Transient throttles (HTTP 429 — RPM *or* concurrent-jobs — and 502/503) are absorbed here with
 * exponential backoff + jitter (`luma-retry.ts`, ADR 0016) rather than thrown at the job loop:
 * a 429 that bubbles out just gets re-fired on the next 3 s tick, which adds to the RPM pressure
 * and never lets the queue drain. The port contract is unchanged — `create` / `get` still either
 * resolve or throw; they just try harder first.
 *
 * Talks to a live API, so it is covered by `test/adapters/luma-generation-client.test.ts` with a
 * stubbed `fetch` (request shape + response mapping + error surface + retry behaviour), not by the
 * scenario suite (which drives `FakeGenerationClient`).
 */
import type { Config } from "../config.js";
import type {
  GenerationClient,
  GenerationHandle,
  GenerationResult,
  GenerationState,
} from "../ports/generation-client.js";
import type { GenerationQuality } from "../domain/types.js";
import { backoffDelayMs, isRetryableStatus } from "./luma-retry.js";

interface LumaOutput {
  readonly type?: string;
  readonly url?: string;
}
interface LumaGenerationBody {
  readonly id: string;
  readonly state: string;
  readonly output?: readonly LumaOutput[] | null;
  readonly failure_reason?: string | null;
  readonly failure_code?: string | null;
}

const KNOWN_STATES: readonly GenerationState[] = [
  "queued",
  "processing",
  "completed",
  "failed",
];

function isKnownState(raw: string): raw is GenerationState {
  return (KNOWN_STATES as readonly string[]).includes(raw);
}

/**
 * Strict: for polling, an unrecognised `state` means the API changed under us and we must not guess.
 */
function mapState(raw: string): GenerationState {
  if (isKnownState(raw)) return raw;
  throw new Error(
    `Luma returned an unrecognised generation state: ${JSON.stringify(raw)}`,
  );
}

/**
 * Lenient: at `create` time the generation already exists and is paid for, so an unknown state is
 * treated as `queued` (the poller sorts it out) rather than thrown — a throw here would strand a
 * billed generation with no attempt row.
 */
function mapCreateState(raw: string): GenerationState {
  return isKnownState(raw) ? raw : "queued";
}

function modelFor(quality: GenerationQuality): string {
  return quality === "final" ? "uni-1-max" : "uni-1";
}

/** ~30s ceiling on every Luma call — Node's `fetch` has no default timeout, and a hung socket
 *  plus the job-loop's no-overlap guard would wedge the whole pipeline silently. */
const REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/** One retry, as handed to `onRetry` for logging. */
export interface LumaRetryInfo {
  /** `"create"` | `"get"`. */
  readonly op: string;
  /** 1-based: the retry about to be attempted. */
  readonly attempt: number;
  /** How long we are about to sleep (ms). */
  readonly delayMs: number;
  /** The HTTP status that triggered the retry, or `null` for a thrown network / timeout error. */
  readonly status: number | null;
  readonly reqId: string | null;
}

export interface LumaClientDeps {
  /** Sleep between retries. Defaults to a real `setTimeout`; tests inject an instant resolver. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `[0, 1)` source for jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Called once per retry, before the sleep. Defaults to `console.warn`; `main` wires the logger. */
  readonly onRetry?: (info: LumaRetryInfo) => void;
  /** Epoch-ms clock for `X-RateLimit-Reset` math. Defaults to `Date.now`. */
  readonly now?: () => number;
}

async function lumaError(op: string, res: Response): Promise<Error> {
  // Read the body once as text — `res.json()` consumes the stream, so a JSON-parse failure can't
  // then fall back to `res.text()`. Non-JSON error bodies (proxy HTML, plain text) still surface.
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as { detail?: string };
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
    // keep the raw text
  }
  const reqId = res.headers.get("x-request-id") ?? "?";
  return new Error(
    `Luma ${op} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""} (x-request-id: ${reqId})`,
  );
}

export class LumaGenerationClient implements GenerationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onRetry: (info: LumaRetryInfo) => void;
  private readonly now: () => number;
  private readonly retry: {
    readonly maxRetries: number;
    readonly baseMs: number;
    readonly maxDelayMs: number;
  };

  constructor(config: Config, deps: LumaClientDeps = {}) {
    this.baseUrl = config.luma.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.luma.apiKey;

    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.onRetry =
      deps.onRetry ??
      ((info) =>
        console.warn(
          `luma retry: ${info.op} attempt ${info.attempt} in ${info.delayMs}ms (status ${info.status ?? "network error"})`,
        ));
    this.now = deps.now ?? Date.now;

    // `?? default` (not a hard read) so `{ luma: { apiKey, baseUrl } } as Config` test fixtures,
    // which carry none of these, still construct.
    this.retry = {
      maxRetries: config.luma.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseMs: config.luma.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      maxDelayMs: config.luma.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    };
  }

  /**
   * `fetch` + the non-2xx check, wrapped in a bounded retry loop. Returns a 2xx `Response` (the
   * caller reads the body) or throws the same tagged error the single-shot version used to.
   *
   * `idempotent` gates whether a *thrown* `fetch` error (network drop, our own timeout abort) is
   * retried: safe for `GET` (a poll, free and repeatable), NOT for `POST /generations` — the
   * request may have queued a billed generation server-side, and a blind retry would double-spend.
   * A retryable *status* (429/502/503) means the server rejected the request before doing any
   * work, so it is retried for both.
   */
  private async send(
    op: string,
    url: string,
    init: RequestInit,
    opts: { idempotent: boolean },
  ): Promise<Response> {
    // attempt 0 is the first try; 1..maxRetries are retries.
    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (opts.idempotent && attempt < this.retry.maxRetries) {
          const delayMs = backoffDelayMs({
            attempt,
            headers: new Headers(),
            baseMs: this.retry.baseMs,
            maxDelayMs: this.retry.maxDelayMs,
            now: this.now(),
            random: this.random,
          });
          this.onRetry({
            op,
            attempt: attempt + 1,
            delayMs,
            status: null,
            reqId: null,
          });
          await this.sleep(delayMs);
          continue;
        }
        throw err;
      }

      if (res.ok) return res;

      if (isRetryableStatus(res.status) && attempt < this.retry.maxRetries) {
        const delayMs = backoffDelayMs({
          attempt,
          headers: res.headers,
          baseMs: this.retry.baseMs,
          maxDelayMs: this.retry.maxDelayMs,
          now: this.now(),
          random: this.random,
        });
        this.onRetry({
          op,
          attempt: attempt + 1,
          delayMs,
          status: res.status,
          reqId: res.headers.get("x-request-id"),
        });
        // Drain the body so the socket is released before we sleep.
        await res.text().catch(() => "");
        await this.sleep(delayMs);
        continue;
      }

      throw await lumaError(op, res);
    }
  }

  async create(input: {
    prompt: string;
    sourceImageUrl: string;
    quality: GenerationQuality;
  }): Promise<GenerationHandle> {
    const res = await this.send(
      "create",
      `${this.baseUrl}/generations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "image_edit",
          prompt: input.prompt,
          source: { url: input.sourceImageUrl },
          model: modelFor(input.quality),
        }),
      },
      { idempotent: false },
    );
    const body = (await res.json()) as LumaGenerationBody;
    return { id: body.id, state: mapCreateState(body.state) };
  }

  async get(generationId: string): Promise<GenerationResult> {
    const res = await this.send(
      "get",
      `${this.baseUrl}/generations/${encodeURIComponent(generationId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      { idempotent: true },
    );
    const body = (await res.json()) as LumaGenerationBody;
    const state = mapState(body.state);
    return {
      id: body.id,
      state,
      imageUrl:
        state === "completed"
          ? ((body.output ?? []).find((o) => typeof o.url === "string")?.url ??
            null)
          : null,
      failureReason: body.failure_reason ?? null,
      failureCode: body.failure_code ?? null,
    };
  }
}
