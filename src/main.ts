/**
 * Composition root + process entry.
 *
 * Boots, in order:
 *  1. migrations (idempotent — the volume mounts at runtime, so this can't be a pre-deploy step)
 *  2. the HTTP server (health check + image hosting) — always, so the deploy goes green
 *  3. the Slack app (Socket Mode) + the in-process job loop — when `loadConfig()` succeeds
 *
 * Wave 1 wired (3) for F1 catalog intake; Wave 2 added the job loop that drives F3a drafting and
 * polls Luma; Wave 3 extends the same loop with F4 Finals (kick → resolve → post) and wires the
 * Keep / "Finish picking" taps; Wave 4 adds F2 Request capture (ingest opens `proposed` Requests
 * for blank rows; the Slack runtime confirms them). Wave 7 adds F7 — the batch status post (one
 * Slack message per CSV import, all review threaded underneath it, ADR 0019) — via a shared
 * `refreshBatchStatus` hook wired into every status transition, plus a periodic self-heal sweep
 * (`sweepOpenBatches`) in the same job loop. Wave 5 adds F3b — the one retry Draft per rejection
 * (folded into the same job loop) and the staleness scheduler (a second, slow interval that
 * escalates un-tapped Drafts to the escalation contact).
 *
 * This is the ONLY module besides `migrate.ts` that reads `process.env` directly, and only for the
 * handful of values needed before `loadConfig` can run (the HTTP server is built first so the
 * deploy goes green even without Slack secrets). Everything downstream takes a `Config`.
 */
import path from "node:path";

import { LumaGenerationClient } from "./adapters/luma-generation-client.js";
import { R2ImageStore } from "./adapters/r2-image-store.js";
import { SqliteRepository } from "./adapters/sqlite-repository.js";
import { SystemClock } from "./adapters/system-clock.js";
import { VolumeImageStore } from "./adapters/volume-image-store.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { SlackFailureTracker } from "./app/slack-failure-tracker.js";
import { startJobLoop, type JobLoop } from "./runtime/job-loop.js";
import { buildHttpServer, startHttpServer } from "./runtime/http.js";
import {
  startStalenessScheduler,
  type Scheduler,
} from "./runtime/scheduler.js";
import { createSlackApp, type SlackRuntime } from "./runtime/slack-events.js";

async function main(): Promise<void> {
  // Pre-config bootstrap: the HTTP server must start before `loadConfig()` so the deploy goes green
  // even without Slack secrets. `PORT=0` (bind any free port) is honoured; anything non-numeric
  // falls back. This mirrors `config.ts`'s `num("PORT", 8080)`.
  const rawPort = Number(process.env.PORT);
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : 8080;
  const dataDir = process.env.DATA_DIR ?? "data";
  // R2 mode → `/img/*` redirects to R2 instead of serving an (always-empty) volume dir, so legacy
  // `/img/...` links baked before the R2 cutover keep resolving. `loadConfig` validates these
  // properly later; here we only need enough to shape the one route.
  const imgRedirectBase =
    (process.env.IMAGE_STORE ?? "volume") === "r2"
      ? process.env.R2_PUBLIC_BASE_URL
      : undefined;

  runMigrations(dataDir);

  const http = await buildHttpServer({
    imagesDir: path.resolve(dataDir, "images"),
    ...(imgRedirectBase ? { imgRedirectBase } : {}),
  });
  await startHttpServer(http, port);
  http.log.info({ port, dataDir }, "http server up (/healthz, /img/*)");

  // --- pipeline wiring -------------------------------------------------
  const clock = new SystemClock();
  let repo: SqliteRepository | undefined;
  let slack: SlackRuntime | undefined;
  let jobLoop: JobLoop | undefined;
  let staleScheduler: Scheduler | undefined;
  try {
    const config = loadConfig();
    repo = new SqliteRepository(path.resolve(config.dataDir, "app.db"));
    repo.migrate();

    const imageStore = config.r2 ? new R2ImageStore(config) : new VolumeImageStore(config);
    http.log.info(
      config.r2
        ? { store: "r2", bucket: config.r2.bucket, publicBaseUrl: config.r2.publicBaseUrl }
        : { store: "volume", dataDir: config.dataDir },
      "image store selected",
    );
    slack = createSlackApp(config, { repo, clock });
    await slack.app.start();

    jobLoop = startJobLoop(
      {
        repo,
        clock,
        generationClient: new LumaGenerationClient(config, {
          onRetry: (info) => http.log.warn(info, "luma retry"),
        }),
        imageStore,
        gateway: slack.gateway,
        config,
        onItemError: (context, err) =>
          http.log.error({ err }, `pipeline tick: ${context}`),
        slackFailureTracker: new SlackFailureTracker(),
      },
      config.pipeline.pollIntervalMs,
      (err) => http.log.error(err, "pipeline tick failed"),
    );

    staleScheduler = startStalenessScheduler(
      {
        repo,
        clock,
        gateway: slack.gateway,
        config,
        onItemError: (context, err) =>
          http.log.error({ err }, `staleness check: ${context}`),
      },
      config.pipeline.staleSweepIntervalMs,
      (err) => http.log.error(err, "staleness sweep failed"),
    );

    http.log.info(
      "slack app started (socket mode) + job loop + staleness scheduler running — F1 + F2 + F3a + F3b + F4 + F7 live",
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A missing secret is expected (http-only); a socket that won't open is a real failure. Tear
    // down whatever we built so shutdown doesn't act on a half-started pipeline.
    http.log.warn(
      { reason },
      slack
        ? "slack app failed to start — running http-only"
        : "slack not configured — running http-only",
    );
    jobLoop?.stop();
    jobLoop = undefined;
    staleScheduler?.stop();
    staleScheduler = undefined;
    await slack?.app.stop().catch(() => undefined);
    slack = undefined;
    repo?.close();
    repo = undefined;
  }

  // --- graceful shutdown --------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    http.log.info({ signal }, "shutting down");
    try {
      jobLoop?.stop();
      staleScheduler?.stop();
      await slack?.app.stop();
      await http.close();
      repo?.close();
      process.exit(0);
    } catch (err) {
      http.log.error(err, "error during shutdown");
      process.exit(1);
    }
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => void shutdown(sig));
  }
}

main().catch((err) => {
  console.error("fatal boot error", err);
  process.exit(1);
});
