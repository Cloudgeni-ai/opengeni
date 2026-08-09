import { describe, expect, test } from "bun:test";
import type { EditableArtifactOutboxDispatchSummary } from "@opengeni/core";
import type { Observability } from "@opengeni/observability";

import {
  createEditableArtifactOutboxService,
  readEditableArtifactOutboxSidecarEnvironment,
  type EditableArtifactOutboxRuntimePort,
} from "../src/editable-artifact-outbox-service";

const EMPTY_SUMMARY: EditableArtifactOutboxDispatchSummary = Object.freeze({
  claimed: 0,
  published: 0,
  retried: 0,
  deadLettered: 0,
  leaseLost: 0,
});

describe("editable artifact outbox sidecar", () => {
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
      },
    };
    const observability = {
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
      check: async () => {
        throw new Error("dependency unavailable");
      },
    };
    const service = createEditableArtifactOutboxService({
      runtime,
      observability: {
        prometheusMetrics: async () => "",
      } as unknown as Observability,
      serviceName: "opengeni-test",
      environment: "test",
    });
    await expect(service.run()).rejects.toThrow("dependency unavailable");
    expect(service.state()).toBe("failed");
    expect((await service.fetch(new Request("http://worker/readyz"))).status).toBe(503);
    expect((await service.fetch(new Request("http://worker/healthz"))).status).toBe(503);
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}
