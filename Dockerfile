# syntax=docker/dockerfile:1

# --- build stage -----------------------------------------------------------
# Node 22 (an LTS line @slack/bolt v5 is CI-tested against). Local dev / vitest run on Node 26;
# nothing in the runtime path depends on the difference.
FROM node:22-bookworm AS build
WORKDIR /app

# better-sqlite3@13 has NO install/postinstall script and ships glibc prebuilts
# (prebuilds/linux-{x64,arm64}.node) inside its tarball — node-gyp never runs, so no
# python3/make/g++ toolchain is needed here.
#
# node:22-bookworm ships npm 10.9, which aborts `npm ci` with EBADPLATFORM on the esbuild
# per-platform packages recorded in the lockfile (npm/cli #4828). npm 11 skips
# platform-mismatched optional deps correctly.
RUN npm install -g npm@11

COPY package.json package-lock.json ./
# --omit=optional also drops esbuild's per-platform binaries (tsx/vitest pull them);
# the container only runs `tsc` (build) and `node` (runtime), never tsx/vitest.
RUN npm ci --omit=optional

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --omit=optional

# --- runtime stage -------------------------------------------------------
# Same base OS/libc as the build stage so the better-sqlite3 .node binary loads.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini for correct PID-1 signal forwarding (SIGTERM -> graceful Fastify shutdown in main.ts).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The Railway volume mounts at runtime (not build); main.ts creates data/ + data/images/ on boot.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app

# Stay root at container start: a platform-managed volume (Railway, or any bind-mount host) is
# mounted at runtime *over* /app/data and comes back root-owned regardless of the build-time
# chown above, so the app would hit EACCES creating data/images on first boot. `setpriv` re-chowns
# the live mount, then execs (not forks) as `node` — same PID, so tini's signal forwarding for
# graceful shutdown (ADR 0006) still reaches the app directly.
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "chown -R node:node \"$DATA_DIR\" && exec setpriv --reuid=node --regid=node --init-groups node dist/main.js"]
