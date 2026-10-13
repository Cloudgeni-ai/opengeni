import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { EditableArtifactOutboxDispatchSummary } from "@opengeni/core";
import type { Observability } from "@opengeni/observability";

import {
  createEditableArtifactOutboxService,
  readEditableArtifactOutboxSidecarEnvironment,
  type EditableArtifactOutboxRuntimePort,
} from "../src/editable-artifact-outbox-service";

const HEALTHY = Object.freeze({ databaseRole: { ok: true }, nats: { ok: true } } as const);

const EMPTY_SUMMARY: EditableArtifactOutboxDispatchSummary = Object.freeze({
  claimed: 0,
  published: 0,
  retried: 0,
  deadLettered: 0,
  leaseLost: 0,
});

describe("editable artifact outbox sidecar", () => {
  test("composes from its explicit environment without unrelated API or sandbox secrets", () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/artifact-outbox-config.ts", import.meta.url))],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, OPENGENI_NATS_URL: "nats://ambient.invalid:4222" },
        timeout: 20_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("explicit sidecar environment composed");
  });
  test("is disabled by default and validates the dedicated posture", () => {
    expect(readEditableArtifactOutboxSidecarEnvironment({})).toBeNull();
    expect(() =>
      readEditableArtifactOutboxSidecarEnvironment({
        OPENGENI_ARTIFACT_OUTBOX_ENABLED: "true",
        OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE: "opengeni_app",
        OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL:
          "postgres://opengeni_app:secret@db.internal/opengeni",
      }),
    ).toThrow("DATABASE_ROLE");

    const environment = readEditableArtifactOutboxSidecarEnvironment({
      OPENGENI_ARTIFACT_OUTBOX_ENABLED: "true",
      OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE: "opengeni_artifact_outbox_dispatcher",
      OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL:
        "postgres://opengeni_artifact_outbox_dispatcher:secret@db.internal/opengeni",
      OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT: "19466",
      OPENGENI_ARTIFACT_OUTBOX_LEASE_MS: "3000",
      OPENGENI_ARTIFACT_OUTBOX_RENEW_MS: "1000",
    });
    expect(environment).toMatchObject({
      httpPort: 19_466,
      leaseDurationMs: 3_000,
      leaseRenewIntervalMs: 1_000,
    });
  });

  test("readiness is dependency-backed and drain closes the supervised loop", async () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let checks = 0;
    let drains = 0;
    let stops = 0;
    const runtime: EditableArtifactOutboxRuntimePort = {
      dispatcher: { dispatchOnce: async () => EMPTY_SUMMARY },
      start: () => running,
      drain() {
        drains += 1;
        finish();
        return true;
      },
      async stop() {
        stops += 1;
      },
      async check() {
        checks += 1;
        return HEALTHY;
      },
    };
    const observability = {
      ...quietObservability(),
      prometheusMetrics: async () => "# metrics\n",
    } as unknown as Observability;
    const service = createEditableArtifactOutboxService({
      runtime,
      observability,
      serviceName: "opengeni-test",
      environment: "test",
    });

    const run = service.run();
    await eventually(() => service.state() === "ready");
    expect((await service.fetch(new Request("http://worker/readyz"))).status).toBe(200);
    expect(await (await service.fetch(new Request("http://worker/metrics"))).text()).toBe(
      "# metrics\n",
    );
    expect(checks).toBeGreaterThanOrEqual(2);

    expect(service.drain()).toBe(true);
    await run;
    expect(service.state()).toBe("stopped");
    await service.close();
    expect(drains).toBe(1);
    expect(stops).toBe(1);
    expect((await service.fetch(new Request("http://worker/healthz"))).status).toBe(503);
  });

  test("failed readiness never reports a live process as ready", async () => {
    const runtime: EditableArtifactOutboxRuntimePort = {
      dispatcher: { dispatchOnce: async () => EMPTY_SUMMARY },
      start: async () => undefined,
      drain: () => true,
      stop: async () => undefined,
      check: async () => ({
        databaseRole: { ok: true },
        nats: { ok: false, reason: "dependency unavailable" },
      }),
    };
    const service = createEditableArtifactOutboxService({
      runtime,
      observability: quietObservability(),
      serviceName: "opengeni-test",
      environment: "test",
    });
    await expect(service.run()).rejects.toThrow(
      "Artifact outbox dispatcher is not ready: nats: dependency unavailable",
    );
    expect(service.state()).toBe("failed");
    const readyz = await service.fetch(new Request("http://worker/readyz"));
    expect(readyz.status).toBe(503);
    expect(await readyz.json()).toMatchObject({
      checks: {
        databaseRole: { ok: true },
        nats: { ok: false, reason: "dependency unavailable" },
      },
    });
    expect((await service.fetch(new Request("http://worker/healthz"))).status).toBe(503);
  });

  test("a readiness failure on a running dispatcher names the failing check and is logged once", async () => {
    let posture: { ok: true } | { ok: false; reason: string } = { ok: true };
    const logs = { warn: [] as string[], info: [] as string[] };
    const runtime: EditableArtifactOutboxRuntimePort = {
      dispatcher: { dispatchOnce: async () => EMPTY_SUMMARY },
      start: () => new Promise<void>(() => undefined),
      drain: () => true,
      stop: async () => undefined,
      check: async () => ({ databaseRole: posture, nats: { ok: true } }),
    };
    const service = createEditableArtifactOutboxService({
      runtime,
      observability: {
        prometheusMetrics: async () => "",
        warn: (message: string) => logs.warn.push(message),
        info: (message: string) => logs.info.push(message),
      } as unknown as Observability,
      serviceName: "opengeni-test",
      environment: "test",
    });
    void service.run();
    await eventually(() => service.state() === "ready");
    expect(logs.warn).toEqual([]);

    const reason =
      "Artifact outbox dispatcher database connection has an unsafe role posture: it can directly access public.metrics_view";
    posture = { ok: false, reason };
    for (let probe = 0; probe < 3; probe += 1) {
      const readyz = await service.fetch(new Request("http://worker/readyz"));
      expect(readyz.status).toBe(503);
      expect(await readyz.json()).toEqual({
        ok: false,
        state: "ready",
        checks: { databaseRole: { ok: false, reason }, nats: { ok: true } },
      });
    }
    expect(logs.warn).toEqual([
      `Artifact outbox dispatcher readiness check failing: databaseRole: ${reason}`,
    ]);

    posture = { ok: true };
    expect((await service.fetch(new Request("http://worker/readyz"))).status).toBe(200);
    expect(logs.info).toEqual(["Artifact outbox dispatcher readiness check recovered"]);
    expect(logs.warn).toHaveLength(1);
  });

  test("a probe that outlives the readiness budget reports only itself as timed out", async () => {
    const runtime: EditableArtifactOutboxRuntimePort = {
      dispatcher: { dispatchOnce: async () => EMPTY_SUMMARY },
      start: () => new Promise<void>(() => undefined),
      drain: () => true,
      stop: async () => undefined,
      check: async (signal) => ({
        databaseRole: { ok: true },
        nats: await new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve({ ok: false, reason: "timed out" })),
        ),
      }),
    };
    const service = createEditableArtifactOutboxService({
      runtime,
      observability: quietObservability(),
      serviceName: "opengeni-test",
      environment: "test",
      readinessTimeoutMs: 20,
    });
    await expect(service.run()).rejects.toThrow("is not ready: nats: timed out");
    expect(await (await service.fetch(new Request("http://worker/readyz"))).json()).toMatchObject({
      checks: { databaseRole: { ok: true }, nats: { ok: false, reason: "timed out" } },
    });
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

function quietObservability(): Observability {
  return {
    prometheusMetrics: async () => "",
    warn: () => undefined,
    info: () => undefined,
  } as unknown as Observability;
}
