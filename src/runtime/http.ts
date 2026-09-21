import { mkdirSync } from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

export interface HttpDeps {
  /** Absolute path to the directory holding published images. */
  imagesDir: string;
  /** Called by GET /healthz — return false to fail the check. */
  isHealthy?: () => boolean;
  /** Fastify request logging. Default true; tests pass false. */
  logger?: boolean;
  /**
   * When set (R2 mode), `GET /img/*` 302-redirects to `${imgRedirectBase}/<file>` instead of
   * serving bytes from `imagesDir`. Heals legacy `/img/...` URLs baked into `published_images`
   * / old Slack messages before the R2 cutover (ADR 0017) — the object lives in R2 now, not on
   * the volume (which is empty under `IMAGE_STORE=r2`).
   */
  imgRedirectBase?: string;
}

/**
 * The only HTTP surface. Two routes:
 *  - GET /healthz         Railway health check (any 2xx passes; only gates the initial deploy)
 *  - GET /img/:filename   stable, permanent URLs for published images (heals the IMG_43xx scar).
 *                         Volume mode → served from disk; R2 mode (`imgRedirectBase` set) →
 *                         302-redirected to R2 so legacy `/img/...` links keep working.
 *
 * Slack needs no inbound HTTP — the app runs in Socket Mode.
 *
 * Side effect: creates `imagesDir` (recursively) if it does not exist, so `/img/*` works on a
 * first boot against a freshly-mounted volume.
 */
export async function buildHttpServer(
  deps: HttpDeps,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? true });

  const imagesDir = path.resolve(deps.imagesDir);
  mkdirSync(imagesDir, { recursive: true }); // recursive: no-op if it already exists, no TOCTOU

  app.get("/healthz", async (_req, reply) => {
    const ok = deps.isHealthy ? deps.isHealthy() : true;
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? "ok" : "unavailable" });
  });

  if (deps.imgRedirectBase) {
    const base = deps.imgRedirectBase.replace(/\/+$/, "");
    app.get("/img/*", async (req, reply) => {
      const rest = (req.params as Record<string, string>)["*"] ?? "";
      // No traversal, no directory index — `rest` must be a plain filename.
      if (rest === "" || rest.includes("..") || rest.includes("/")) {
        return reply.code(404).send({ error: "Not Found" });
      }
      return reply.redirect(`${base}/${rest}`, 302);
    });
  } else {
    await app.register(fastifyStatic, {
      root: imagesDir,
      prefix: "/img/",
      index: false,
      list: false,
      // Stable filenames, but a regenerated pick reuses its name — so cache, don't freeze.
      cacheControl: true,
      maxAge: "1d",
      immutable: false,
    });
  }

  return app;
}

/** Start listening on 0.0.0.0:PORT — 0.0.0.0 is mandatory inside a container. */
export async function startHttpServer(
  app: FastifyInstance,
  port: number,
): Promise<void> {
  await app.listen({ port, host: "0.0.0.0" });
}
