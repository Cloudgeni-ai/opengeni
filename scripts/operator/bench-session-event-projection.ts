import { startTestServices } from "@opengeni/testing";

// WAL is cluster-wide. Always own a fresh disposable PostgreSQL instance rather
// than sampling an operator-provided URL, which may have unrelated writers.
const services = await startTestServices({ temporal: false });
try {
  const child = Bun.spawn(
    ["bun", "test", "packages/db/test/single-semantic-event-projection.test.ts"],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      env: {
        ...Bun.env,
        OPENGENI_REQUIRE_REAL_DB: "1",
        OPENGENI_TEST_PG_URL: services.databaseUrl,
        OPENGENI_BENCH_EVENT_PROJECTION: "1",
        OPENGENI_BENCH_EVENT_PROJECTION_WAL: "1",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Projection benchmark failed (${exitCode})`);
} finally {
  await services.down();
}
process.exit(0);
