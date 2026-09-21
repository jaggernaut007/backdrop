/**
 * Runtime configuration, read once from an environment map. Outside of `main.ts` (which does a
 * tiny pre-config bootstrap read of `PORT` / `DATA_DIR` so it can boot HTTP-only when Slack
 * secrets are absent), nothing else in the codebase touches `process.env` — everything takes a
 * `Config`. Operational parameters (stale threshold, per-image cost, finals count) are config
 * values, not hardcoded beliefs — ASSUMPTIONS.md Part C.
 */

export interface Config {
  readonly nodeEnv: string;
  readonly port: number;

  /** Directory holding `app.db` (the Railway volume can shrink to ~1 GB). */
  readonly dataDir: string;
  /** Public origin the image store builds stable URLs against, e.g. https://x.up.railway.app */
  readonly publicBaseUrl: string;

  /** R2 config (if IMAGE_STORE=r2). Omit for local dev / tests (use VolumeImageStore). */
  readonly r2: {
    readonly bucket: string;
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly publicBaseUrl: string;
  } | undefined;

  readonly slack: {
    readonly botToken: string;
    readonly appToken: string;
    readonly channelId: string;
    /** The single binding actor. Any other tap is inert (ASSUMPTIONS.md A2). */
    readonly approverUserId: string;
    /** Stale-escalation target (ASSUMPTIONS.md C, stale threshold). */
    readonly escalationUserId: string;
    /**
     * When true (the default), the binding-actor gate on Approve / Reject is lifted — *any* Slack
     * user in the channel can tap, and their own id is recorded as the actor on the Decision. This
     * is the open-by-default posture: anyone with the workspace invite can drive the whole workflow.
     * Set `OPEN_APPROVAL=false` to restore decision 3 / ASSUMPTIONS.md A2 — only the configured
     * `APPROVER_SLACK_USER_ID` tap is binding, every other tap is inert. An empty actor id is never
     * binding either way.
     */
    readonly openApproval: boolean;
  };

  readonly luma: {
    readonly apiKey: string;
    readonly baseUrl: string;
    /** Retries after the first attempt on a transient 429/502/503 (ADR 0016). 0 disables retry. */
    readonly maxRetries: number;
    /** Exponential-backoff base (ms): the nth retry waits `base * 2^n` + jitter. */
    readonly retryBaseMs: number;
    /** Ceiling for the exponential branch (ms); `Retry-After` / `X-RateLimit-Reset` still win. */
    readonly retryMaxDelayMs: number;
  };

  readonly pipeline: {
    /** Un-tapped Draft older than this escalates to the escalation contact (ASSUMPTIONS.md C: 3 calendar days). */
    readonly staleThresholdDays: number;
    /** Finals generated per approved direction (ASSUMPTIONS.md C: 3). */
    readonly finalsPerDirection: number;
    /** Configured cents constant logged on every attempt — Luma bills async. */
    readonly draftCostCents: number;
    readonly finalCostCents: number;
    /** job-loop poll interval (ms). */
    readonly pollIntervalMs: number;
    /** staleness sweep interval (ms). */
    readonly staleSweepIntervalMs: number;
    /** Global cap on pending Luma generations — no new `create` fires while at this count. */
    readonly maxInFlightGenerations: number;
    /** Per-tick cap on Draft `create` calls (fresh drafts + retries share this budget). */
    readonly maxDraftsPerTick: number;
    /** Per-tick cap on Requests moved into Finals. */
    readonly maxFinalsStartsPerTick: number;
  };
}

type EnvMap = Record<string, string | undefined>;

function req(env: EnvMap, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function opt(env: EnvMap, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** Non-negative number (allows fractions and 0) — for cost cents and the `PORT`. */
function num(env: EnvMap, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} is not a number: ${v}`);
  return n;
}

/** Positive integer — for counts and intervals where 0 / negative / fractional is nonsense. */
function posInt(env: EnvMap, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Env ${name} must be a positive integer, got: ${v}`);
  }
  return n;
}

/** Boolean env — `"1" | "true" | "yes"` (case-insensitive) is true; anything else / unset is `fallback`. */
function bool(env: EnvMap, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes"].includes(v.trim().toLowerCase());
}

/** Non-negative integer — like `posInt` but `0` is a legal value (e.g. "disable retries"). */
function nonNegInt(env: EnvMap, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Env ${name} must be a non-negative integer, got: ${v}`);
  }
  return n;
}

/**
 * Build config from an environment map (defaults to `process.env`). Pure — it does not mutate the
 * map or `process.env`. Throws on a missing secret, or a non-sensical numeric, so a misconfigured
 * deploy fails fast at boot rather than at the first Slack call.
 */
export function loadConfig(env: EnvMap = process.env): Config {
  const imageStore = opt(env, "IMAGE_STORE", "volume");
  const r2Config =
    imageStore === "r2"
      ? {
          bucket: req(env, "R2_BUCKET"),
          endpoint: req(env, "R2_ENDPOINT"),
          accessKeyId: req(env, "R2_ACCESS_KEY_ID"),
          secretAccessKey: req(env, "R2_SECRET_ACCESS_KEY"),
          publicBaseUrl: req(env, "R2_PUBLIC_BASE_URL"),
        }
      : undefined;

  return {
    nodeEnv: opt(env, "NODE_ENV", "development"),
    port: num(env, "PORT", 8080),
    dataDir: opt(env, "DATA_DIR", "data"),
    publicBaseUrl: opt(env, "PUBLIC_BASE_URL", "http://localhost:8080"),
    slack: {
      botToken: req(env, "SLACK_BOT_TOKEN"),
      appToken: req(env, "SLACK_APP_TOKEN"),
      channelId: req(env, "SLACK_CHANNEL_ID"),
      approverUserId: req(env, "APPROVER_SLACK_USER_ID"),
      escalationUserId: req(env, "ESCALATION_SLACK_USER_ID"),
      openApproval: bool(env, "OPEN_APPROVAL", true),
    },
    luma: {
      apiKey: req(env, "LUMA_AGENTS_API_KEY"),
      baseUrl: opt(env, "LUMA_BASE_URL", "https://agents.lumalabs.ai/v1"),
      maxRetries: nonNegInt(env, "LUMA_MAX_RETRIES", 5),
      retryBaseMs: posInt(env, "LUMA_RETRY_BASE_MS", 1_000),
      retryMaxDelayMs: posInt(env, "LUMA_RETRY_MAX_DELAY_MS", 30_000),
    },
    pipeline: {
      staleThresholdDays: posInt(env, "STALE_THRESHOLD_DAYS", 3),
      finalsPerDirection: posInt(env, "FINALS_PER_DIRECTION", 2),
      draftCostCents: num(env, "DRAFT_COST_CENTS", 5),
      finalCostCents: num(env, "FINAL_COST_CENTS", 11),
      pollIntervalMs: posInt(env, "POLL_INTERVAL_MS", 5_000),
      staleSweepIntervalMs: posInt(env, "STALE_SWEEP_INTERVAL_MS", 3_600_000),
      maxInFlightGenerations: posInt(env, "MAX_IN_FLIGHT_GENERATIONS", 4),
      maxDraftsPerTick: posInt(env, "MAX_DRAFTS_PER_TICK", 2),
      maxFinalsStartsPerTick: posInt(env, "MAX_FINALS_STARTS_PER_TICK", 1),
    },
    r2: r2Config,
  };
}
