import { describe, expect, test } from "bun:test";

import type { Database } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";

import { EditableArtifactMaterializer } from "../src/editable-artifact-materializer";
import {
  assertDedicatedMaterializerDatabaseRole,
  createEditableArtifactMaterializerService,
  readEditableArtifactMaterializerSidecarEnvironment,
} from "../src/editable-artifact-materializer-service";

describe("editable artifact materializer sidecar service", () => {
  test("owns readiness, drain, and database shutdown independently", async () => {
    const loopStarted = deferred<void>();
    let closed = 0;
    const materializer = {
      async run(signal: AbortSignal) {
        loopStarted.resolve();
        await waitForAbort(signal);
      },
      async drain() {},
      async dispatchOnce() {
        return {
          claimed: 0,
          succeeded: 0,
          deadLettered: 0,
          retryDeferred: 0,
          leaseLost: 0,
          cancelled: 0,
          claimFailed: false,
        };
      },
    } as unknown as EditableArtifactMaterializer;
    const service = createEditableArtifactMaterializerService({
      materializer,
      db: postureDatabase(),
      closeDatabase: async () => {
        closed += 1;
      },
      observability: observability(),
      serviceName: "test-worker",
      environment: "test",
      deploymentRevision: "test-revision",
      runtimeCapability: {
        mode: "development-current-host",
        sandboxEnforced: false,
      },
    });

    expect(service.state()).toBe("starting");
    expect((await service.fetch(new Request("http://worker.test/readyz"))).status).toBe(503);
    const running = service.run();
    await loopStarted.promise;
    expect(service.state()).toBe("ready");
    const ready = await service.fetch(new Request("http://worker.test/readyz"));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      state: "ready",
      runtime: { mode: "development-current-host", sandboxEnforced: false },
      checks: { databaseRole: { ok: true } },
    });

    expect(service.drain("test")).toBe(true);
    expect(service.state()).toBe("draining");
    expect((await service.fetch(new Request("http://worker.test/healthz"))).status).toBe(200);
    await running;
    expect(service.state()).toBe("stopped");
    await service.close();
    await service.close();
    expect(closed).toBe(1);
    expect((await service.fetch(new Request("http://worker.test/healthz"))).status).toBe(503);
  });

  test("wrong or table-privileged DB role fails readiness and service startup", async () => {
    for (const database of [
      postureDatabase({ current_role: "opengeni_app", session_role: "opengeni_app" }),
      postureDatabase({ can_select_jobs: true }),
    ]) {
      await expect(assertDedicatedMaterializerDatabaseRole(database)).rejects.toThrow(
        "unsafe role posture",
      );
    }
  });

  test("disabled sidecar ignores ordinary DB configuration and never starts accidentally", () => {
    expect(
      readEditableArtifactMaterializerSidecarEnvironment({
        OPENGENI_DATABASE_URL: "postgres://ordinary-runtime",
      }),
    ).toBeNull();
  });

  test("enabled sidecar requires the distinct DSN, exact role, and executable", () => {
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        OPENGENI_ARTIFACT_MATERIALIZER_ENABLED: "true",
        OPENGENI_DATABASE_URL: "postgres://ordinary-runtime",
      }),
    ).toThrow("OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL is required");
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        OPENGENI_ARTIFACT_MATERIALIZER_ENABLED: "true",
        OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL: "postgres://dedicated",
        OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE: "opengeni_app",
      }),
    ).toThrow("DATABASE_ROLE is invalid");
  });

  test("sidecar environment parses a complete bounded production configuration", () => {
    const result = readEditableArtifactMaterializerSidecarEnvironment({
      OPENGENI_ARTIFACT_MATERIALIZER_ENABLED: "true",
      OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL: "postgres://dedicated",
      OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE: "opengeni_artifact_materializer",
      OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE: "/opt/opengeni/artifact-codec",
      OPENGENI_ARTIFACT_MATERIALIZER_BWRAP: "/usr/bin/bwrap",
      OPENGENI_ARTIFACT_MATERIALIZER_PRLIMIT: "/usr/bin/prlimit",
      OPENGENI_ARTIFACT_RUNTIME_MANIFEST: "/opt/opengeni/runtime.json",
      OPENGENI_ARTIFACT_TOOL_ENTRY: "/opt/opengeni/artifact-tool.js",
      OPENGENI_ARTIFACT_MATERIALIZER_OWNER: "worker-1",
      OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT: "9466",
      OPENGENI_ARTIFACT_MATERIALIZER_BATCH_SIZE: "4",
      OPENGENI_ARTIFACT_MATERIALIZER_CONCURRENCY: "2",
      OPENGENI_ARTIFACT_MATERIALIZER_LEASE_MS: "60000",
      OPENGENI_ARTIFACT_MATERIALIZER_RENEW_MS: "10000",
      OPENGENI_ARTIFACT_MATERIALIZER_OPEN_FILES: "96",
      OPENGENI_ARTIFACT_MATERIALIZER_PROCESSES: "48",
      OPENGENI_ARTIFACT_MATERIALIZER_FILE_BYTES: "268435456",
    });
    expect(result).toMatchObject({
      databaseUrl: "postgres://dedicated",
      declaredDatabaseRole: "opengeni_artifact_materializer",
      executable: "/opt/opengeni/artifact-codec",
      bubblewrapExecutable: "/usr/bin/bwrap",
      prlimitExecutable: "/usr/bin/prlimit",
      runtimeAuthority: {
        mode: "production",
        environmentVariable: "OPENGENI_ARTIFACT_RUNTIME_MANIFEST",
        manifestPath: "/opt/opengeni/runtime.json",
      },
      owner: "worker-1",
      httpPort: 9466,
      batchSize: 4,
      concurrency: 2,
      leaseDurationMs: 60_000,
      leaseRenewIntervalMs: 10_000,
      fileDescriptorLimit: 96,
      processLimit: 48,
      fileSizeLimitBytes: 256 * 1024 * 1024,
    });
  });

  test("development authority requires every explicit local unsandboxed gate", () => {
    const complete = developmentEnvironment();
    const parsed = readEditableArtifactMaterializerSidecarEnvironment(complete);
    expect(parsed).toMatchObject({
      bubblewrapExecutable: null,
      prlimitExecutable: null,
      allowUnsandboxedLocalDevelopment: true,
      httpHostname: "127.0.0.1",
      runtimeAuthority: {
        mode: "development-current-host",
        environmentVariable: "OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST",
        manifestPath: "/tmp/opengeni/installation.development.json",
      },
    });

    for (const missing of [
      "OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT",
      "OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT",
    ] as const) {
      const environment = { ...complete };
      delete environment[missing];
      expect(() => readEditableArtifactMaterializerSidecarEnvironment(environment)).toThrow(
        "explicit local-development gates",
      );
    }
  });

  test("development manifest alone, production mode, dual authority, and remote services fail closed", () => {
    const complete = developmentEnvironment();
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        ...complete,
        OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT: undefined,
        OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT: undefined,
      }),
    ).toThrow("explicit local-development gates");
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        ...complete,
        NODE_ENV: "production",
      }),
    ).toThrow("forbidden when NODE_ENV=production");
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        ...complete,
        OPENGENI_ARTIFACT_RUNTIME_MANIFEST: "/opt/opengeni/installation.json",
      }),
    ).toThrow("cannot both be configured");
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        ...complete,
        OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL:
          "postgres://opengeni_artifact_materializer:secret@db.internal/opengeni",
      }),
    ).toThrow("loopback database DSN");
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        ...complete,
        OPENGENI_OBJECT_STORAGE_ENDPOINT: "https://objects.example.test",
      }),
    ).toThrow("loopback object storage");
    expect(() =>
      readEditableArtifactMaterializerSidecarEnvironment({
        ...complete,
        OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST: "0.0.0.0",
      }),
    ).toThrow("loopback HTTP listener");
  });

  test("ordinary Temporal worker entry never imports or starts the sidecar", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).not.toContain("artifact-materializer-entry");
    expect(source).not.toContain("createMaterializerSidecarFromEnvironment");
  });
});

function developmentEnvironment(): NodeJS.ProcessEnv {
  return {
    OPENGENI_ARTIFACT_MATERIALIZER_ENABLED: "true",
    OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL:
      "postgres://opengeni_artifact_materializer:secret@127.0.0.1:5432/opengeni",
    OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE: "opengeni_artifact_materializer",
    OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE: "/tmp/opengeni/opengeni-artifact-materializer",
    OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST: "/tmp/opengeni/installation.development.json",
    OPENGENI_ARTIFACT_TOOL_ENTRY: "/tmp/opengeni/skill-facade-entry.mjs",
    OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT: "true",
    OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT: "true",
    OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST: "127.0.0.1",
    OPENGENI_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
    NODE_ENV: "development",
  };
}

function postureDatabase(
  override: Partial<{
    current_role: string;
    session_role: string;
    can_select_jobs: boolean;
    can_insert_jobs: boolean;
    can_update_jobs: boolean;
    can_delete_jobs: boolean;
  }> = {},
): Database {
  return {
    async execute() {
      return [
        {
          current_role: "opengeni_artifact_materializer",
          session_role: "opengeni_artifact_materializer",
          can_select_jobs: false,
          can_insert_jobs: false,
          can_update_jobs: false,
          can_delete_jobs: false,
          ...override,
        },
      ];
    },
  } as unknown as Database;
}

function observability() {
  return createObservability(
    {
      serviceName: "test",
      environment: "test",
      deploymentRevision: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: false,
      observabilityOtlpHeaders: "",
    },
    { component: "artifact-materializer-test" },
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
