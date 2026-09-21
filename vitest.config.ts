import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.{test,spec}.ts"],
    // Scenario tests drive an in-process pipeline with fakes — no network, no real timers.
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",
        // Bootstrap: mkdir + `new SqliteRepository(dbPath).migrate()`. The schema DDL it runs is
        // exercised through the repository contract suite; the wrapper itself is process glue.
        "src/migrate.ts",
        "src/**/*.d.ts",
        // Live-workspace plumbing — driven by FakeSlackGateway in the suite, verified manually
        // against a real Slack app in the demo (see AUDIT-LOG.md).
        "src/adapters/bolt-slack-gateway.ts",
        "src/runtime/slack-events.ts",
        // Thin `setInterval` glue over `app/run-pipeline-tick` (which is unit-tested directly).
        "src/runtime/job-loop.ts",
        // Thin `setInterval` glue over `app/staleness-check` (which is unit-tested directly).
        "src/runtime/scheduler.ts",
      ],
    },
  },
});
