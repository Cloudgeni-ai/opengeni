import { dbSearchPath, getSettings, type Settings } from "@opengeni/config";
import {
  createDb,
  dbSql,
  PostgresEditableArtifactMaterializationRepository,
  type Database,
} from "@opengeni/db";
import { createObservability, type Observability } from "@opengeni/observability";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import { dirname } from "node:path";

import {
  EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE,
  EDITABLE_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES,
  EDITABLE_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES,
  EditableArtifactMaterializer,
  createConfiguredEditableArtifactMaterializer,
  systemEditableArtifactMaterializerClock,
  systemEditableArtifactMaterializerScheduler,
  type EditableArtifactMaterializerPassSummary,
} from "./editable-artifact-materializer";
import {
  createEditableArtifactObjectStorageReader,
  createEditableArtifactObjectStorageVerifier,
  createEditableArtifactObjectStorageWriter,
} from "./editable-artifact-materializer-storage";
import {
  createNativeEditableArtifactSubprocessPort,
  type NativeEditableArtifactSubprocessOptions,
} from "./editable-artifact-materializer-subprocess";
import {
  createDevelopmentEditableArtifactProcessLauncher,
  createLinuxEditableArtifactProcessLauncher,
} from "./editable-artifact-materializer-launcher";

export type EditableArtifactRuntimeAuthority =
  | Readonly<{
      mode: "production";
      environmentVariable: "OPENGENI_ARTIFACT_RUNTIME_MANIFEST";
      manifestPath: string;
    }>
  | Readonly<{
      mode: "development-current-host";
      environmentVariable: "OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST";
      manifestPath: string;
    }>;

export type EditableArtifactMaterializerServiceState =
  | "starting"
  | "ready"
  | "draining"
  | "stopped"
  | "failed";

export type EditableArtifactMaterializerService = Readonly<{
  state(): EditableArtifactMaterializerServiceState;
  run(): Promise<void>;
  drain(reason?: string): boolean;
  close(): Promise<void>;
  dispatchOnce(signal?: AbortSignal): Promise<EditableArtifactMaterializerPassSummary>;
  fetch(request: Request): Promise<Response>;
}>;

export type CreateEditableArtifactMaterializerServiceInput = Readonly<{
  materializer: EditableArtifactMaterializer;
  db: Database;
  closeDatabase: () => Promise<void>;
  observability: Observability;
  serviceName: string;
  environment: string;
  deploymentRevision?: string;
  readinessTimeoutMs?: number;
  runtimeCapability?: Readonly<{
    mode: EditableArtifactRuntimeAuthority["mode"];
    sandboxEnforced: boolean;
  }>;
}>;

export type ProductionEditableArtifactMaterializerServiceOptions = Readonly<{
  settings: Settings;
  /** Dedicated DSN; never defaults to settings.databaseUrl. */
  databaseUrl: string;
  declaredDatabaseRole: string;
  executable: string;
  bubblewrapExecutable: string | null;
  prlimitExecutable: string | null;
  runtimeAuthority: EditableArtifactRuntimeAuthority;
  /** Explicit exception selected only by the validated local-dev sidecar config. */
  allowUnsandboxedLocalDevelopment?: boolean;
  skillFacadeEntrypoint: string;
  owner: string;
  objectStorage?: ObjectStorage;
  batchSize?: number;
  concurrency?: number;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  memoryLimitBytes: number;
  cpuTimeLimitMs: number;
  fileDescriptorLimit: number;
  processLimit: number;
  fileSizeLimitBytes: number;
  wallTimeoutMs: number;
  nodeEnvironment?: string;
  maxSourceBytes?: number;
  maxOutputBytes?: number;
}>;

/**
 * Compose the distinct production sidecar. It creates its own connection pool
 * from the dedicated DSN and never reuses a control/turn worker handle.
 */
export async function createProductionEditableArtifactMaterializerService(
  options: ProductionEditableArtifactMaterializerServiceOptions,
): Promise<EditableArtifactMaterializerService> {
  if (options.declaredDatabaseRole !== EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE) {
    throw new Error("Artifact materializer database role declaration is invalid");
  }
  if (typeof options.databaseUrl !== "string" || options.databaseUrl.trim().length === 0) {
    throw new Error("Artifact materializer requires its dedicated database DSN");
  }
  const maxSourceBytes = options.maxSourceBytes ?? EDITABLE_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? EDITABLE_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES;
  const concurrency = options.concurrency ?? 2;
  const development = options.runtimeAuthority.mode === "development-current-host";
  if (development !== (options.allowUnsandboxedLocalDevelopment === true)) {
    throw new Error("Artifact materializer runtime authority and local-development gate differ");
  }
  const launcher = development
    ? await createDevelopmentEditableArtifactProcessLauncher({
        materializerExecutable: options.executable,
        explicitlyEnabled: options.allowUnsandboxedLocalDevelopment === true,
        nodeEnvironment: options.nodeEnvironment,
      })
    : await createLinuxEditableArtifactProcessLauncher({
        materializerExecutable: options.executable,
        bubblewrapExecutable: requiredOption(options.bubblewrapExecutable, "bubblewrap"),
        prlimitExecutable: requiredOption(options.prlimitExecutable, "prlimit"),
        runtimeRoot: dirname(options.runtimeAuthority.manifestPath),
        memoryLimitBytes: options.memoryLimitBytes,
        cpuTimeLimitMs: options.cpuTimeLimitMs,
        fileDescriptorLimit: options.fileDescriptorLimit,
        processLimit: options.processLimit,
        fileSizeLimitBytes: options.fileSizeLimitBytes,
      });
  const searchPath = dbSearchPath(options.settings);
  const dbClient = createDb(options.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    ...(options.settings.rlsStrategy ? { rlsStrategy: options.settings.rlsStrategy } : {}),
    max: Math.max(2, concurrency + 1),
  });
  let created = false;
  try {
    await assertDedicatedMaterializerDatabaseRole(dbClient.db);
    const objectStorage = options.objectStorage ?? createObjectStorage(options.settings);
    if (!objectStorage) throw new Error("Artifact materializer object storage is unavailable");
    const subprocessOptions: NativeEditableArtifactSubprocessOptions = {
      executable: options.executable,
      launcher,
      childEnvironment:
        options.runtimeAuthority.mode === "production"
          ? Object.freeze({
              OPENGENI_ARTIFACT_RUNTIME_MANIFEST: options.runtimeAuthority.manifestPath,
              OPENGENI_ARTIFACT_TOOL_ENTRY: options.skillFacadeEntrypoint,
            })
          : Object.freeze({
              NODE_ENV: "development",
              OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST: options.runtimeAuthority.manifestPath,
              OPENGENI_ARTIFACT_TOOL_ENTRY: options.skillFacadeEntrypoint,
            }),
      ...(development ? { allowUnsandboxedDevelopment: true } : {}),
      wallTimeoutMs: options.wallTimeoutMs,
      maxSourceBytes,
      maxOutputBytes,
    };
    const kernel = await createNativeEditableArtifactSubprocessPort(subprocessOptions);
    const repository = new PostgresEditableArtifactMaterializationRepository(dbClient.db, {
      ...(options.settings.dbSchema.trim() ? { dataSchema: options.settings.dbSchema.trim() } : {}),
    });
    const observability = createObservability(options.settings, {
      component: "artifact-materializer",
    });
    if (development) {
      observability.warn("Artifact materializer is running without an OS sandbox", {
        errorClass: "DevelopmentSecurityPosture",
        errorCode: "artifact_materializer_unsandboxed_development",
        origin: "worker",
        outcome: "degraded",
      });
    }
    const materializer = createConfiguredEditableArtifactMaterializer({
      enabled: true,
      databaseRole: options.declaredDatabaseRole,
      objectStorageConfigured: true,
      ...(development ? { allowUnsandboxedDevelopment: true } : {}),
      dependencies: {
        store: repository,
        sourceReader: createEditableArtifactObjectStorageReader(objectStorage),
        outputWriter: createEditableArtifactObjectStorageWriter(objectStorage),
        outputVerifier: createEditableArtifactObjectStorageVerifier(objectStorage, {
          verify: kernel.verifyMaterialization,
        }),
        kernel,
        scheduler: systemEditableArtifactMaterializerScheduler,
        clock: systemEditableArtifactMaterializerClock,
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
        metrics: {
          increment(outcome, count = 1) {
            observability.incrementCounter({
              name: "opengeni_artifact_materializations_total",
              help: "Editable artifact materialization attempts by closed outcome.",
              labels: { outcome },
              amount: count,
            });
          },
        },
      },
      options: {
        owner: options.owner,
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        concurrency,
        ...(options.leaseDurationMs !== undefined
          ? { leaseDurationMs: options.leaseDurationMs }
          : {}),
        ...(options.leaseRenewIntervalMs !== undefined
          ? { leaseRenewIntervalMs: options.leaseRenewIntervalMs }
          : {}),
        ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        maxSourceBytes,
        maxOutputBytes,
      },
    });
    if (!materializer) throw new Error("Artifact materializer is unexpectedly disabled");
    created = true;
    return createEditableArtifactMaterializerService({
      materializer,
      db: dbClient.db,
      closeDatabase: dbClient.close,
      observability,
      serviceName: options.settings.serviceName,
      environment: options.settings.environment,
      deploymentRevision: options.settings.deploymentRevision,
      runtimeCapability: Object.freeze({
        mode: options.runtimeAuthority.mode,
        sandboxEnforced: launcher.identity.sandboxEnforced,
      }),
    });
  } finally {
    if (!created) await dbClient.close();
  }
}

export function createEditableArtifactMaterializerService(
  input: CreateEditableArtifactMaterializerServiceInput,
): EditableArtifactMaterializerService {
  let state: EditableArtifactMaterializerServiceState = "starting";
  let runPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let databaseClosed = false;
  const abort = new AbortController();
  const readinessTimeoutMs = input.readinessTimeoutMs ?? 2_000;

  const ready = async (): Promise<void> => {
    await withTimeout(assertDedicatedMaterializerDatabaseRole(input.db), readinessTimeoutMs);
  };

  const run = (): Promise<void> => {
    if (runPromise) return runPromise;
    if (state !== "starting") {
      return Promise.reject(new Error("Artifact materializer service cannot be restarted"));
    }
    runPromise = (async () => {
      try {
        await ready();
        if (abort.signal.aborted) {
          state = "stopped";
          return;
        }
        state = "ready";
        await input.materializer.run(abort.signal);
        const exitWasDraining = (state as EditableArtifactMaterializerServiceState) === "draining";
        state = exitWasDraining ? "stopped" : "failed";
        if (!exitWasDraining) {
          throw new Error("Artifact materializer loop exited without a drain request");
        }
      } catch (error) {
        const caughtState = state as EditableArtifactMaterializerServiceState;
        if (caughtState !== "draining" && caughtState !== "stopped") state = "failed";
        throw error;
      }
    })();
    return runPromise;
  };

  const drain = (_reason = "shutdown"): boolean => {
    if (state === "draining" || state === "stopped" || state === "failed") return false;
    state = "draining";
    abort.abort();
    return true;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      drain("close");
      if (runPromise) await runPromise.catch(() => undefined);
      await input.materializer.drain();
      if (!databaseClosed) {
        databaseClosed = true;
        await input.closeDatabase();
      }
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
          component: "artifact-materializer",
          environment: input.environment,
          ...(input.deploymentRevision ? { deploymentRevision: input.deploymentRevision } : {}),
          runtime: input.runtimeCapability ?? {
            mode: "production",
            sandboxEnforced: true,
          },
          state,
          ok,
        },
        { status: ok ? 200 : 503 },
      );
    }
    if (url.pathname === "/readyz") {
      if (state !== "ready") {
        return Response.json(
          { ok: false, state, checks: { databaseRole: { ok: false } } },
          { status: 503 },
        );
      }
      try {
        await ready();
        return Response.json({
          ok: true,
          state,
          runtime: input.runtimeCapability ?? {
            mode: "production",
            sandboxEnforced: true,
          },
          checks: { databaseRole: { ok: true } },
        });
      } catch {
        return Response.json(
          { ok: false, state, checks: { databaseRole: { ok: false } } },
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
    dispatchOnce: async (signal?: AbortSignal) => await input.materializer.dispatchOnce(signal),
    fetch,
  });
}

export async function assertDedicatedMaterializerDatabaseRole(db: Database): Promise<void> {
  const raw = await db.execute<{
    current_role: string;
    session_role: string;
    can_select_jobs: boolean;
    can_insert_jobs: boolean;
    can_update_jobs: boolean;
    can_delete_jobs: boolean;
  }>(dbSql`
    select
      current_user::text as current_role,
      session_user::text as session_role,
      has_table_privilege(
        current_user,
        format('%I.editable_artifact_materialization_jobs', current_schema()),
        'SELECT'
      ) as can_select_jobs,
      has_table_privilege(
        current_user,
        format('%I.editable_artifact_materialization_jobs', current_schema()),
        'INSERT'
      ) as can_insert_jobs,
      has_table_privilege(
        current_user,
        format('%I.editable_artifact_materialization_jobs', current_schema()),
        'UPDATE'
      ) as can_update_jobs,
      has_table_privilege(
        current_user,
        format('%I.editable_artifact_materialization_jobs', current_schema()),
        'DELETE'
      ) as can_delete_jobs
  `);
  const rows = Array.isArray(raw) ? raw : ((raw as unknown as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as
    | {
        current_role?: unknown;
        session_role?: unknown;
        can_select_jobs?: unknown;
        can_insert_jobs?: unknown;
        can_update_jobs?: unknown;
        can_delete_jobs?: unknown;
      }
    | undefined;
  if (
    row?.current_role !== EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE ||
    row.session_role !== EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE ||
    row.can_select_jobs !== false ||
    row.can_insert_jobs !== false ||
    row.can_update_jobs !== false ||
    row.can_delete_jobs !== false
  ) {
    throw new Error("Artifact materializer database connection has an unsafe role posture");
  }
}

export type EditableArtifactMaterializerSidecarEnvironment = Readonly<{
  databaseUrl: string;
  declaredDatabaseRole: string;
  executable: string;
  bubblewrapExecutable: string | null;
  prlimitExecutable: string | null;
  runtimeAuthority: EditableArtifactRuntimeAuthority;
  skillFacadeEntrypoint: string;
  owner: string;
  httpHostname: string;
  httpPort: number;
  batchSize: number;
  concurrency: number;
  leaseDurationMs: number;
  leaseRenewIntervalMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  memoryLimitBytes: number;
  cpuTimeLimitMs: number;
  fileDescriptorLimit: number;
  processLimit: number;
  fileSizeLimitBytes: number;
  wallTimeoutMs: number;
  maxSourceBytes: number;
  maxOutputBytes: number;
  allowUnsandboxedLocalDevelopment: boolean;
  nodeEnvironment?: string;
}>;

export function readEditableArtifactMaterializerSidecarEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EditableArtifactMaterializerSidecarEnvironment | null {
  if (environment.OPENGENI_ARTIFACT_MATERIALIZER_ENABLED !== "true") return null;
  const databaseUrl = required(environment, "OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL");
  const declaredDatabaseRole = required(
    environment,
    "OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE",
  );
  if (declaredDatabaseRole !== EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE) {
    throw new Error("OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE is invalid");
  }
  const productionManifest = optional(environment, "OPENGENI_ARTIFACT_RUNTIME_MANIFEST");
  const developmentManifest = optional(
    environment,
    "OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST",
  );
  if (productionManifest && developmentManifest) {
    throw new Error(
      "Production and development artifact runtime manifests cannot both be configured",
    );
  }
  if (!productionManifest && !developmentManifest) {
    throw new Error(
      "An artifact runtime manifest is required when artifact materialization is enabled",
    );
  }
  const development = developmentManifest !== null;
  if (development) {
    if (environment.NODE_ENV === "production") {
      throw new Error("Development artifact runtime is forbidden when NODE_ENV=production");
    }
    if (
      environment.OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT !== "true" ||
      environment.OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT !== "true"
    ) {
      throw new Error(
        "Unsandboxed artifact materialization requires explicit local-development gates",
      );
    }
    assertLoopbackDatabaseUrl(databaseUrl);
    assertLoopbackObjectStorageUrl(required(environment, "OPENGENI_OBJECT_STORAGE_ENDPOINT"));
  }
  const httpHostname =
    optional(environment, "OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST") ?? "0.0.0.0";
  if (development && !isLoopbackHostname(httpHostname)) {
    throw new Error("Unsandboxed artifact materialization requires a loopback HTTP listener");
  }
  const runtimeAuthority: EditableArtifactRuntimeAuthority = developmentManifest
    ? Object.freeze({
        mode: "development-current-host",
        environmentVariable: "OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST",
        manifestPath: developmentManifest,
      })
    : Object.freeze({
        mode: "production",
        environmentVariable: "OPENGENI_ARTIFACT_RUNTIME_MANIFEST",
        manifestPath: productionManifest!,
      });
  return Object.freeze({
    databaseUrl,
    declaredDatabaseRole,
    executable: required(environment, "OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE"),
    bubblewrapExecutable: development
      ? null
      : required(environment, "OPENGENI_ARTIFACT_MATERIALIZER_BWRAP"),
    prlimitExecutable: development
      ? null
      : required(environment, "OPENGENI_ARTIFACT_MATERIALIZER_PRLIMIT"),
    runtimeAuthority,
    allowUnsandboxedLocalDevelopment: development,
    skillFacadeEntrypoint: required(environment, "OPENGENI_ARTIFACT_TOOL_ENTRY"),
    owner:
      environment.OPENGENI_ARTIFACT_MATERIALIZER_OWNER?.trim() ||
      `materializer-${process.pid}-${crypto.randomUUID()}`,
    httpHostname,
    httpPort: integer(environment, "OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT", 9465, 1, 65_535),
    batchSize: integer(environment, "OPENGENI_ARTIFACT_MATERIALIZER_BATCH_SIZE", 8, 1, 64),
    concurrency: integer(environment, "OPENGENI_ARTIFACT_MATERIALIZER_CONCURRENCY", 2, 1, 64),
    leaseDurationMs: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_LEASE_MS",
      120_000,
      10_000,
      86_400_000,
    ),
    leaseRenewIntervalMs: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_RENEW_MS",
      30_000,
      1_000,
      43_199_999,
    ),
    pollIntervalMs: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_POLL_MS",
      1_000,
      10,
      60_000,
    ),
    maxAttempts: integer(environment, "OPENGENI_ARTIFACT_MATERIALIZER_MAX_ATTEMPTS", 20, 1, 1_000),
    memoryLimitBytes: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_MEMORY_BYTES",
      512 * 1024 * 1024,
      64 * 1024 * 1024,
      8 * 1024 * 1024 * 1024,
    ),
    cpuTimeLimitMs: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_CPU_MS",
      60_000,
      1_000,
      3_600_000,
    ),
    fileDescriptorLimit: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_OPEN_FILES",
      64,
      16,
      4_096,
    ),
    processLimit: integer(environment, "OPENGENI_ARTIFACT_MATERIALIZER_PROCESSES", 64, 1, 1_024),
    fileSizeLimitBytes: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_FILE_BYTES",
      512 * 1024 * 1024,
      1024 * 1024,
      8 * 1024 * 1024 * 1024,
    ),
    wallTimeoutMs: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_WALL_MS",
      120_000,
      1_000,
      3_600_000,
    ),
    maxSourceBytes: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES",
      EDITABLE_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES,
      1,
      EDITABLE_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES,
    ),
    maxOutputBytes: integer(
      environment,
      "OPENGENI_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES",
      EDITABLE_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES,
      1,
      EDITABLE_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES,
    ),
    ...(environment.NODE_ENV === undefined ? {} : { nodeEnvironment: environment.NODE_ENV }),
  });
}

export async function createMaterializerSidecarFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{
  service: EditableArtifactMaterializerService;
  httpHostname: string;
  httpPort: number;
}> | null> {
  const sidecar = readEditableArtifactMaterializerSidecarEnvironment(environment);
  if (!sidecar) return null;
  const settings = getSettings();
  const service = await createProductionEditableArtifactMaterializerService({
    settings,
    databaseUrl: sidecar.databaseUrl,
    declaredDatabaseRole: sidecar.declaredDatabaseRole,
    executable: sidecar.executable,
    bubblewrapExecutable: sidecar.bubblewrapExecutable,
    prlimitExecutable: sidecar.prlimitExecutable,
    runtimeAuthority: sidecar.runtimeAuthority,
    ...(sidecar.allowUnsandboxedLocalDevelopment ? { allowUnsandboxedLocalDevelopment: true } : {}),
    skillFacadeEntrypoint: sidecar.skillFacadeEntrypoint,
    owner: sidecar.owner,
    batchSize: sidecar.batchSize,
    concurrency: sidecar.concurrency,
    leaseDurationMs: sidecar.leaseDurationMs,
    leaseRenewIntervalMs: sidecar.leaseRenewIntervalMs,
    pollIntervalMs: sidecar.pollIntervalMs,
    maxAttempts: sidecar.maxAttempts,
    memoryLimitBytes: sidecar.memoryLimitBytes,
    cpuTimeLimitMs: sidecar.cpuTimeLimitMs,
    fileDescriptorLimit: sidecar.fileDescriptorLimit,
    processLimit: sidecar.processLimit,
    fileSizeLimitBytes: sidecar.fileSizeLimitBytes,
    wallTimeoutMs: sidecar.wallTimeoutMs,
    maxSourceBytes: sidecar.maxSourceBytes,
    maxOutputBytes: sidecar.maxOutputBytes,
    ...(sidecar.nodeEnvironment === undefined ? {} : { nodeEnvironment: sidecar.nodeEnvironment }),
  });
  return Object.freeze({
    service,
    httpHostname: sidecar.httpHostname,
    httpPort: sidecar.httpPort,
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("readiness check timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when artifact materialization is enabled`);
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value = environment[name]?.trim();
  return value ? value : null;
}

function requiredOption(value: string | null, name: string): string {
  if (!value) throw new Error(`Artifact materializer ${name} is required in production`);
  return value;
}

function assertLoopbackDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Local-development artifact materializer database DSN is invalid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Local-development artifact materializer database DSN is invalid");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("Unsandboxed artifact materialization requires a loopback database DSN");
  }
}

function assertLoopbackObjectStorageUrl(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Local-development artifact object-storage endpoint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !isLoopbackHostname(parsed.hostname)
  ) {
    throw new Error("Unsandboxed artifact materialization requires loopback object storage");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
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
