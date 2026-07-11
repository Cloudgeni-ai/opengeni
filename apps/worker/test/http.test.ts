import { testSettings } from "@opengeni/testing";
import { afterEach, describe, expect, it } from "bun:test";
import { runReadinessChecks, schemaReadyCheck, startWorkerHttpServer } from "../src/http";

const digest = (value: string) => `sha256:${value.repeat(64)}`;
const releaseSchema = {
  migrationSetSha256: digest("a"),
  contractsSha256: digest("b"),
  migrations: ["0049_example.sql", "0050_next.sql"],
};

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("worker release health and readiness", () => {
  it("projects the full immutable image set and DB-verified schema hashes", async () => {
    const settings = testSettings({
      workerHttpPort: 0,
      deploymentRevision: "c".repeat(40),
      deploymentImageDigests: {
        api: digest("1"),
        worker: digest("2"),
        web: digest("3"),
        relay: digest("4"),
      },
      releaseSchema,
    });
    const schema = schemaReadyCheck(
      {
        execute: async () => releaseSchema.migrations.map((name) => ({ name })),
      } as never,
      releaseSchema,
    );
    server = startWorkerHttpServer({
      settings,
      observability: { prometheusMetrics: async () => "" } as never,
      checks: { db: async () => {}, nats: () => {}, temporal: async () => {}, schema },
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${baseUrl}/healthz`)).json()).toMatchObject({
      deploymentRevision: "c".repeat(40),
      images: {
        api: { digest: digest("1") },
        worker: { digest: digest("2") },
        web: { digest: digest("3") },
        relay: { digest: digest("4") },
      },
    });
    expect(await (await fetch(`${baseUrl}/readyz`)).json()).toMatchObject({
      ok: true,
      checks: {
        schema: {
          ok: true,
          migrationSetSha256: releaseSchema.migrationSetSha256,
          contractsSha256: releaseSchema.contractsSha256,
        },
      },
    });
  });

  it("fails closed when the live migration set differs", async () => {
    const result = await runReadinessChecks({
      db: async () => {},
      nats: () => {},
      temporal: async () => {},
      schema: schemaReadyCheck(
        { execute: async () => [{ name: "0049_example.sql" }] } as never,
        releaseSchema,
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.schema).toMatchObject({
      ok: false,
      error: "applied migration names do not match the reviewed release schema",
    });
  });
});
