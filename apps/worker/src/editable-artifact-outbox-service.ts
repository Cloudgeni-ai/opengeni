import {
  dbSearchPath,
  getSettings,
  resolveNatsControlPlaneAuth,
  type Settings,
} from "@opengeni/config";
import type { EditableArtifactOutboxDispatchSummary } from "@opengeni/core";
import { createObservability, type Observability } from "@opengeni/observability";

import {
  EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV,
  EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE,
  createEditableArtifactOutboxWorker,
  type EditableArtifactOutboxWorkerRuntime,
} from "./editable-artifact-outbox-dispatcher";
import type { EditableArtifactHintNatsAuth } from "./editable-artifact-hint-broker";

export type EditableArtifactOutboxServiceState =
  | "starting"
  | "ready"
  | "draining"
  | "stopped"
  | "failed";

export interface EditableArtifactOutboxRuntimePort {
  start(): Promise<void>;
  drain(): boolean;
  stop(): Promise<void>;
  check(signal?: AbortSignal): Promise<void>;
  readonly dispatcher: Readonly<{
    dispatchOnce(): Promise<EditableArtifactOutboxDispatchSummary>;
  }>;
}

export type EditableArtifactOutboxService = Readonly<{
  state(): EditableArtifactOutboxServiceState;
  run(): Promise<void>;
  drain(reason?: string): boolean;
  close(): Promise<void>;
  dispatchOnce(): Promise<EditableArtifactOutboxDispatchSummary>;
  fetch(request: Request): Promise<Response>;
}>;

export type CreateEditableArtifactOutboxServiceInput = Readonly<{
  runtime: EditableArtifactOutboxRuntimePort;
  observability: Observability;
  serviceName: string;
  environment: string;
  deploymentRevision?: string;
  readinessTimeoutMs?: number;
}>;

export type ProductionEditableArtifactOutboxServiceOptions = Readonly<{
  settings: Settings;
  databaseUrl: string;
  declaredDatabaseRole: string;
  natsUrl: string;
  natsAuth: EditableArtifactHintNatsAuth;
  owner: string;
  databasePoolSize?: number;
  batchSize?: number;
  concurrency?: number;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  pollIntervalMs?: number;
  publishTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}>;

/** Compose the independently supervised production outbox dispatcher. */
export async function createProductionEditableArtifactOutboxService(
  options: ProductionEditableArtifactOutboxServiceOptions,
): Promise<EditableArtifactOutboxService> {
  if (options.declaredDatabaseRole !== EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE) {
    throw new Error("Artifact outbox dispatcher database role declaration is invalid");
  }
  const observability = createObservability(options.settings, {
    component: "artifact-outbox-dispatcher",
  });
  const databaseSearchPath = dbSearchPath(options.settings);
  const runtime = await createEditableArtifactOutboxWorker({
    dispatcherDatabaseUrl: options.databaseUrl,
    ...(databaseSearchPath ? { databaseSearchPath } : {}),
    ...(options.databasePoolSize === undefined
      ? {}
      : { databasePoolSize: options.databasePoolSize }),
    natsUrl: options.natsUrl,
    natsAuth: options.natsAuth,
    owner: options.owner,
    dispatcher: {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: options.leaseDurationMs }),
      ...(options.leaseRenewIntervalMs === undefined
        ? {}
        : { leaseRenewIntervalMs: options.leaseRenewIntervalMs }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.publishTimeoutMs === undefined
        ? {}
        : { publishTimeoutMs: options.publishTimeoutMs }),
      ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
      ...(options.retryMaxMs === undefined ? {} : { retryMaxMs: options.retryMaxMs }),
    },
    metrics: {
      increment(outcome, count = 1) {
        observability.incrementCounter({
          name: "opengeni_artifact_outbox_dispatch_total",
          help: "Editable artifact outbox dispatch actions by closed outcome.",
          labels: { outcome },
          amount: count,
        });
      },
      observePublishSeconds(outcome, seconds) {
        observability.observeHistogram({
          name: "opengeni_artifact_outbox_publish_seconds",
          help: "Editable artifact broker publication latency by closed outcome.",
          labels: { outcome },
          value: seconds,
        });
      },
    },
    logger: {
      warn(message, attributes) {
        observability.warn(message, {
          errorClass: "WorkerOperationError",
          errorCode: "worker_operation_failed",
          origin: "worker",
          outcome: typeof attributes.code === "string" ? attributes.code : "unknown",
        });
      },
    },
  });
  return createEditableArtifactOutboxService({
    runtime,
    observability,
    serviceName: options.settings.serviceName,
    environment: options.settings.environment,
    deploymentRevision: options.settings.deploymentRevision,
  });
}

export function createEditableArtifactOutboxService(
  input: CreateEditableArtifactOutboxServiceInput,
): EditableArtifactOutboxService {
  let state: EditableArtifactOutboxServiceState = "starting";
  let runPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let readinessPromise: Promise<void> | null = null;
  const readinessTimeoutMs = input.readinessTimeoutMs ?? 2_000;

  const ready = (): Promise<void> => {
    if (readinessPromise) return readinessPromise;
    const abort = new AbortController();
    const check = withTimeout(input.runtime.check(abort.signal), readinessTimeoutMs, abort);
    readinessPromise = check;
    void check.then(
      () => {
        if (readinessPromise === check) readinessPromise = null;
      },
      () => {
        if (readinessPromise === check) readinessPromise = null;
      },
    );
    return check;
  };

  const run = (): Promise<void> => {
    if (runPromise) return runPromise;
    if (state !== "starting") {
      return Promise.reject(new Error("Artifact outbox dispatcher service cannot be restarted"));
    }
    runPromise = (async () => {
      try {
        await ready();
        if ((state as EditableArtifactOutboxServiceState) === "draining") {
          state = "stopped";
          return;
        }
        const running = input.runtime.start();
        state = "ready";
        await running;
        const exitWasDraining = (state as EditableArtifactOutboxServiceState) === "draining";
        state = exitWasDraining ? "stopped" : "failed";
        if (!exitWasDraining) {
          throw new Error("Artifact outbox dispatcher exited without a drain request");
        }
      } catch (error) {
        const caughtState = state as EditableArtifactOutboxServiceState;
        if (caughtState !== "draining" && caughtState !== "stopped") state = "failed";
        throw error;
      }
    })();
    return runPromise;
  };

  const drain = (_reason = "shutdown"): boolean => {
    if (state === "draining" || state === "stopped" || state === "failed") return false;
    state = "draining";
    input.runtime.drain();
    return true;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      drain("close");
      if (runPromise) await runPromise.catch(() => undefined);
      await input.runtime.stop();
      if (state !== "failed") state = "stopped";
    })();
    return closePromise;
  };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (url.pathname === "/healthz") {
      const ok = state !== "failed" && state !== "stopped";
      return Response.json(
        {
          service: input.serviceName,
          component: "artifact-outbox-dispatcher",
          environment: input.environment,
          ...(input.deploymentRevision ? { deploymentRevision: input.deploymentRevision } : {}),
          state,
          ok,
        },
        { status: ok ? 200 : 503 },
      );
    }
    if (url.pathname === "/readyz") {
      if (state !== "ready") {
        return Response.json(
          {
            ok: false,
            state,
            checks: { databaseRole: { ok: false }, nats: { ok: false } },
          },
          { status: 503 },
        );
      }
      try {
        await ready();
        return Response.json({
          ok: true,
          state,
          checks: { databaseRole: { ok: true }, nats: { ok: true } },
        });
      } catch {
        return Response.json(
          {
            ok: false,
            state,
            checks: { databaseRole: { ok: false }, nats: { ok: false } },
          },
          { status: 503 },
        );
      }
    }
    if (url.pathname === "/metrics") {
      return new Response(await input.observability.prometheusMetrics(), {
        status: 200,
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  return Object.freeze({
    state: () => state,
    run,
    drain,
    close,
    dispatchOnce: async () => await input.runtime.dispatcher.dispatchOnce(),
    fetch,
  });
}

export type EditableArtifactOutboxSidecarEnvironment = Readonly<{
  databaseUrl: string;
  declaredDatabaseRole: string;
  owner: string;
  httpPort: number;
  databasePoolSize: number;
  batchSize: number;
  concurrency: number;
  leaseDurationMs: number;
  leaseRenewIntervalMs: number;
  pollIntervalMs: number;
  publishTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}>;

export function readEditableArtifactOutboxSidecarEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EditableArtifactOutboxSidecarEnvironment | null {
  if (environment.OPENGENI_ARTIFACT_OUTBOX_ENABLED !== "true") return null;
  const declaredDatabaseRole = required(environment, "OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE");
  if (declaredDatabaseRole !== EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE) {
    throw new Error("OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE is invalid");
  }
  const result = {
    databaseUrl: required(environment, EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV),
    declaredDatabaseRole,
    owner:
      environment.OPENGENI_ARTIFACT_OUTBOX_OWNER?.trim() ||
      `artifact-outbox-${process.pid}-${crypto.randomUUID()}`,
    httpPort: integer(environment, "OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT", 9466, 1, 65_535),
    databasePoolSize: integer(environment, "OPENGENI_ARTIFACT_OUTBOX_DB_POOL_SIZE", 4, 1, 8),
    batchSize: integer(environment, "OPENGENI_ARTIFACT_OUTBOX_BATCH_SIZE", 32, 1, 1_000),
    concurrency: integer(environment, "OPENGENI_ARTIFACT_OUTBOX_CONCURRENCY", 8, 1, 128),
    leaseDurationMs: integer(
      environment,
      "OPENGENI_ARTIFACT_OUTBOX_LEASE_MS",
      30_000,
      1_000,
      86_400_000,
    ),
    leaseRenewIntervalMs: integer(
      environment,
      "OPENGENI_ARTIFACT_OUTBOX_RENEW_MS",
      10_000,
      100,
      43_199_999,
    ),
    pollIntervalMs: integer(environment, "OPENGENI_ARTIFACT_OUTBOX_POLL_MS", 500, 10, 60_000),
    publishTimeoutMs: integer(
      environment,
      "OPENGENI_ARTIFACT_OUTBOX_PUBLISH_TIMEOUT_MS",
      5_000,
      100,
      60_000,
    ),
    retryBaseMs: integer(environment, "OPENGENI_ARTIFACT_OUTBOX_RETRY_BASE_MS", 500, 10, 60_000),
    retryMaxMs: integer(
      environment,
      "OPENGENI_ARTIFACT_OUTBOX_RETRY_MAX_MS",
      60_000,
      10,
      86_400_000,
    ),
  } as const;
  if (result.leaseRenewIntervalMs >= result.leaseDurationMs) {
    throw new Error("OPENGENI_ARTIFACT_OUTBOX_RENEW_MS must be less than lease duration");
  }
  if (result.retryBaseMs > result.retryMaxMs) {
    throw new Error("OPENGENI_ARTIFACT_OUTBOX_RETRY_BASE_MS must not exceed retry max");
  }
  return Object.freeze(result);
}

export async function createOutboxSidecarFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ service: EditableArtifactOutboxService; httpPort: number }> | null> {
  const sidecar = readEditableArtifactOutboxSidecarEnvironment(environment);
  if (!sidecar) return null;
  const settings = getSettings();
  const controlPlaneAuth = resolveNatsControlPlaneAuth(settings);
  const natsAuth: EditableArtifactHintNatsAuth = controlPlaneAuth
    ? {
        kind: "user-password",
        user: controlPlaneAuth.user,
        pass: controlPlaneAuth.password,
      }
    : { kind: "anonymous" };
  const service = await createProductionEditableArtifactOutboxService({
    settings,
    databaseUrl: sidecar.databaseUrl,
    declaredDatabaseRole: sidecar.declaredDatabaseRole,
    natsUrl: settings.natsUrl,
    natsAuth,
    owner: sidecar.owner,
    databasePoolSize: sidecar.databasePoolSize,
    batchSize: sidecar.batchSize,
    concurrency: sidecar.concurrency,
    leaseDurationMs: sidecar.leaseDurationMs,
    leaseRenewIntervalMs: sidecar.leaseRenewIntervalMs,
    pollIntervalMs: sidecar.pollIntervalMs,
    publishTimeoutMs: sidecar.publishTimeoutMs,
    retryBaseMs: sidecar.retryBaseMs,
    retryMaxMs: sidecar.retryMaxMs,
  });
  return Object.freeze({ service, httpPort: sidecar.httpPort });
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  abort: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("readiness check timed out"));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when artifact outbox dispatch is enabled`);
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside its allowed range`);
  }
  return value;
}

// Compile-time assurance that production composition satisfies the service port.
const _runtimePort: EditableArtifactOutboxRuntimePort | undefined = undefined as
  | EditableArtifactOutboxWorkerRuntime
  | undefined;
void _runtimePort;
