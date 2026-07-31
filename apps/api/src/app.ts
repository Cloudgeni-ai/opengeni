import {
  canonicalizeConfiguredModelId,
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  configuredModels,
  withCodexCatalogProvider,
} from "@opengeni/config";
import {
  ClientConfig,
  ErrorEnvelope,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  OPENGENI_CORRELATION_HEADER,
  resolveWorkspaceMemoryEnabled,
  VOICE_INPUT_ACCEPTED_MIME_TYPES,
  type AccessGrant,
  type ErrorCode,
} from "@opengeni/contracts";
import {
  createDocumentServices,
  indexDocumentNow,
  type DocumentServices,
} from "@opengeni/documents";
import { dbSql, getWorkspace } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { createObjectStorage } from "@opengeni/storage";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiRouteDeps, AppDependencies } from "@opengeni/core";
import {
  CodexCompactionV2ProviderLockedError,
  hasPermission,
  requireAccessGrant,
  requirePermission,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
} from "@opengeni/core";
import { createManagedAuth } from "./auth/managed-auth";
import { createApiSandboxClient, makeResumeBoxById } from "./sandbox/access";
import { requireLimit } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "./mcp/server";
import { isToolspaceGrant, prepareToolspaceMcpSurface } from "./mcp/toolspace";
import { boundedMcpRequest, McpPayloadTooLargeError } from "@opengeni/runtime/mcp-network";
import { requireAccessKey } from "./http/auth";
import { registerCapabilityRoutes } from "./routes/capabilities";
import { registerCatalogAssetRoutes } from "./routes/catalog-assets";
import { registerCodexRoutes } from "./routes/codex";
import { registerConnectionRoutes } from "./routes/connections";
import { registerDocumentRoutes } from "./routes/documents";
import { registerEnrollmentRoutes } from "./routes/enrollments";
import { registerMachineRoutes } from "./routes/machines";
import { registerEnvironmentRoutes } from "./routes/environments";
import { registerFileRoutes } from "./routes/files";
import { registerApiKeyRoutes } from "./routes/api-keys";
import { registerBillingRoutes } from "./routes/billing";
import { registerGitHubRoutes } from "./routes/github";
import { registerInstallRoutes } from "./routes/install";
import { registerPackRoutes } from "./routes/packs";
import { registerRigRoutes } from "./routes/rigs";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSocialRoutes } from "./routes/social";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerWorkspaceInstructionPolicyRoutes } from "./routes/workspace-instruction-policies";
import { registerWorkspaceStateRoutes } from "./routes/workspace-state";
import { registerPreferenceRegistryRoutes } from "./routes/preference-registry";
import { registerInsightsRoutes } from "./routes/insights";
import { registerTranscriptionRoutes } from "./routes/transcriptions";
import { projectClientModel } from "./model-catalog";
import { createTranscriptionService } from "./transcription/service";

export type {
  ApiRouteDeps,
  AppDependencies,
  DocumentIndexClient,
  ObjectStorageDependency,
  SessionWorkflowClient,
} from "@opengeni/core";
export {
  mergeResourceRefs,
  mergeToolRefs,
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateGitHubRepositorySelectionShape,
  validateGitHubRepositorySelectionShapes,
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
} from "@opengeni/core";
export { workflowIdForSession } from "@opengeni/core";
export { replaySessionEvents, sseSessionStream, sseWorkspaceControlStream } from "./http/sse";

export const API_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/** Effective Hono bodyLimit — API JSON ceiling or voice multipart + multipart overhead. */
export function apiRequestBodyLimitBytes(settings: { voiceInputMaxSizeBytes: number }): number {
  return Math.max(API_MAX_REQUEST_BODY_BYTES, settings.voiceInputMaxSizeBytes + 64 * 1024);
}
const API_PUBLIC_ERROR_MESSAGE_MAX_BYTES = 512;

export function createApp(deps: AppDependencies): Hono {
  const managedAuth = deps.managedAuth ?? createManagedAuth(deps.settings, deps.db);
  const objectStorage =
    deps.objectStorage === undefined ? createObjectStorage(deps.settings) : deps.objectStorage;
  let documentServices: DocumentServices | null = deps.documentServices ?? null;
  const getDocumentServices = () => {
    documentServices ??= createDocumentServices(deps.settings);
    return documentServices;
  };
  const documentIndexer = deps.documentIndexer ?? {
    indexDocument: async ({
      accountId,
      workspaceId,
      documentId,
    }: {
      accountId: string;
      workspaceId: string;
      documentId: string;
    }) => {
      if (!objectStorage) {
        throw new HTTPException(503, {
          message: "object storage is not configured",
        });
      }
      return await indexDocumentNow(
        deps.db,
        objectStorage,
        workspaceId,
        documentId,
        getDocumentServices(),
        {
          beforeEmbed: async ({ chunkCount }) => {
            await requireLimit(routeDeps, {
              accountId,
              workspaceId,
              action: "document:index",
              quantity: chunkCount,
            });
          },
        },
      );
    },
  };
  // The API process's own agent-loop-free sandbox client — the API-direct
  // control-plane seam. Constructed from settings (resumes boxes by id
  // in-process) unless a client was injected (tests). resumeBoxById is always
  // concrete for routes; it throws SandboxResumeError when sandboxBackend=none.
  const sandboxClient = deps.sandboxClient ?? createApiSandboxClient(deps.settings);
  const resumeBoxById = deps.resumeBoxById ?? makeResumeBoxById(sandboxClient);
  const observability =
    deps.observability ?? createObservability(deps.settings, { component: "api" });
  const transcription =
    deps.transcription === undefined
      ? createTranscriptionService({
          settings: deps.settings,
          db: deps.db,
          ...(deps.codexFetch ? { codexFetch: deps.codexFetch } : {}),
        })
      : deps.transcription;
  const routeDeps: ApiRouteDeps = {
    ...deps,
    observability,
    githubStateSecret:
      deps.githubStateSecret ?? deps.settings.githubAppManifestStateSecret ?? crypto.randomUUID(),
    managedAuth,
    objectStorage,
    documentIndexer,
    getDocumentServices,
    transcription,
    ...(sandboxClient ? { sandboxClient } : {}),
    resumeBoxById,
  };
  const app = new Hono();
  const correlationIds = new WeakMap<Request, string>();

  app.use("*", async (c, next) => {
    const correlationId =
      boundedCorrelationId(c.req.header(OPENGENI_CORRELATION_HEADER)) ?? crypto.randomUUID();
    correlationIds.set(c.req.raw, correlationId);
    c.header(OPENGENI_CORRELATION_HEADER, correlationId);
    await next();
  });

  app.use(
    "*",
    cors({
      credentials: true,
      allowHeaders: [
        "Accept",
        "Authorization",
        "Content-Type",
        "X-OpenGeni-Access-Key",
        "X-OpenGeni-Api-Contract",
        "X-OpenGeni-Correlation-Id",
        "X-OpenGeni-Subject",
      ],
      exposeHeaders: ["X-OpenGeni-Api-Contract", "X-OpenGeni-Correlation-Id"],
      origin: (origin) => {
        if (!origin) {
          return null;
        }
        return allowedCorsOrigin(deps.settings.corsAllowOriginRegex, origin) ? origin : null;
      },
    }),
  );

  app.use(
    "*",
    bodyLimit({
      maxSize: apiRequestBodyLimitBytes(deps.settings),
      onError: (c) =>
        c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." }, 413),
    }),
  );

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const route = routeLabel(url.pathname);
    const correlationId = correlationIds.get(c.req.raw) ?? crypto.randomUUID();
    const start = performance.now();
    const span = observability.startSpan(`HTTP ${c.req.method} ${route}`, {
      "http.request.method": c.req.method,
      "url.path": url.pathname,
      "opengeni.route": route,
    });
    try {
      await next();
      const status = c.res.status || 200;
      const durationSeconds = (performance.now() - start) / 1000;
      observability.recordHttpRequest({
        method: c.req.method,
        route,
        status,
        durationSeconds,
      });
      span.end({
        attributes: {
          "http.response.status_code": status,
          "opengeni.duration_ms": Math.round(durationSeconds * 1000),
        },
      });
      observability.info("HTTP request completed", {
        method: c.req.method,
        route,
        status,
        durationMs: Math.round(durationSeconds * 1000),
        traceId: span.traceId,
        spanId: span.spanId,
        correlationId,
      });
    } catch (error) {
      const status = httpStatusForError(error);
      const errorCode = errorCodeForStatus(status);
      const durationSeconds = (performance.now() - start) / 1000;
      observability.recordHttpRequest({
        method: c.req.method,
        route,
        status,
        durationSeconds,
      });
      observability.incrementCounter({
        name: "opengeni_http_errors_total",
        help: "Total OpenGeni HTTP request failures by bounded route, status, and stable code.",
        labels: { route, status: String(status), code: errorCode },
      });
      span.end({
        attributes: {
          "http.response.status_code": status,
          "opengeni.duration_ms": Math.round(durationSeconds * 1000),
        },
        error,
      });
      observability.error("HTTP request failed", {
        method: c.req.method,
        route,
        status,
        durationMs: Math.round(durationSeconds * 1000),
        traceId: span.traceId,
        spanId: span.spanId,
        correlationId,
        errorCode,
        errorClass: error instanceof Error ? error.name : "NonErrorThrown",
      });
      throw error;
    }
  });

  app.use("*", requireAccessKey(deps.settings));

  app.use("/v1/*", async (c, next) => {
    c.header(OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION);
    if (
      deps.settings.environment !== "test" &&
      isApiContractProtectedMutation(c.req.method, new URL(c.req.url).pathname) &&
      c.req.header(OPENGENI_API_CONTRACT_HEADER) !== OPENGENI_API_CONTRACT_REVISION
    ) {
      return c.json(
        {
          code: "API_CONTRACT_CHANGED",
          message: "OpenGeni updated. Reload this client before changing state.",
          apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        },
        409,
      );
    }
    await next();
  });

  if (managedAuth) {
    app.on(["GET", "POST"], "/v1/auth/*", (c) => managedAuth.handler(c.req.raw));
  }

  app.get("/healthz", (c) =>
    c.json({
      service: deps.settings.serviceName,
      environment: deps.settings.environment,
      deploymentRevision: deps.settings.deploymentRevision,
      ...(deps.settings.serverVersion ? { serverVersion: deps.settings.serverVersion } : {}),
      ok: true,
    }),
  );

  app.get("/readyz", async (c) => {
    const result = await runReadinessChecks(readinessChecks(deps), 2_000);
    return c.json(result, result.ok ? 200 : 503);
  });

  app.get("/traffic-readyz", async (c) => {
    const { db } = readinessChecks(deps);
    const result = await runReadinessChecks({ db }, 2_000);
    return c.json(result, result.ok ? 200 : 503);
  });

  app.get("/metrics", async (c) =>
    c.text(await observability.prometheusMetrics(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    }),
  );

  app.get("/v1/config/client", async (c) => {
    c.header("cache-control", "no-store");
    const catalogSettings = deps.settings.codexSubscriptionEnabled
      ? withCodexCatalogProvider(deps.settings)
      : deps.settings;
    return c.json(
      ClientConfig.parse({
        deploymentRevision: deps.settings.deploymentRevision,
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        ...(deps.settings.serverVersion ? { serverVersion: deps.settings.serverVersion } : {}),
        defaultModel: canonicalizeConfiguredModelId(catalogSettings, catalogSettings.openaiModel),
        allowedModels: configuredAllowedModels(catalogSettings),
        // Provider-grouped model list for the picker. configuredModels() carries the
        // union of the built-in allow-list and every registry provider's models, in
        // selection order (default model first); project each to the client-safe
        // ClientModel shape (ConfiguredModel.providerId → ClientModel.provider).
        models: configuredModels(catalogSettings).map(projectClientModel),
        defaultReasoningEffort: deps.settings.openaiReasoningEffort,
        allowedReasoningEfforts: configuredAllowedReasoningEfforts(deps.settings),
        mcpServers: deps.settings.mcpServers.map((server) => ({
          id: server.id,
          name: server.name ?? server.id,
        })),
        fileUploads: {
          enabled: objectStorage !== null,
          maxSizeBytes: objectStorage?.maxSinglePutSizeBytes ?? 5_000_000_000,
        },
        voiceInput: {
          available: (await transcription?.available()) ?? false,
          maxDurationSeconds: deps.settings.voiceInputMaxDurationSeconds,
          maxSizeBytes: deps.settings.voiceInputMaxSizeBytes,
          acceptedMimeTypes: [...VOICE_INPUT_ACCEPTED_MIME_TYPES],
        },
        productAccessMode: deps.settings.productAccessMode,
        auth: clientAuthConfig(deps.settings),
        // Channel-A structured services (P4.4) ride exec/readFile/createEditor,
        // available on every real backend; `none` has no box so they are all off.
        // Per-session availability is still negotiated on /stream-capabilities.
        structuredServices: structuredServicesHint(deps.settings.sandboxBackend),
      }),
    );
  });

  app.all("/v1/workspaces/:workspaceId/mcp", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    let boundedRequest: Request;
    try {
      boundedRequest = await boundedMcpRequest(c.req.raw);
    } catch (error) {
      if (error instanceof McpPayloadTooLargeError) {
        throw new HTTPException(413, { message: "MCP request body exceeds the safety limit" });
      }
      throw error;
    }
    const grant = await requireMcpAccessGrant(c, routeDeps, workspaceId);
    const toolspaceGrant = isToolspaceGrant(routeDeps.settings, grant);
    const boundSessionId = grant.metadata?.sessionId;
    if (toolspaceGrant || typeof boundSessionId === "string") {
      if (typeof boundSessionId !== "string") {
        throw new HTTPException(404, { message: "session not found" });
      }
      try {
        await requireSessionAuthorization(routeDeps, grant, {
          sessionId: boundSessionId,
          operation: toolspaceGrant ? "session.toolspace.call" : "session.first_party_mcp.call",
          surface: toolspaceGrant ? "toolspace" : "first_party_mcp",
        });
      } catch (error) {
        if (error instanceof SessionAuthorizationDeniedError) {
          throw new HTTPException(404, { message: "session not found" });
        }
        if (error instanceof SessionAuthorizationUnavailableError) {
          throw new HTTPException(503, { message: "session authorization is unavailable" });
        }
        throw error;
      }
    }
    let toolspace: Awaited<ReturnType<typeof prepareToolspaceMcpSurface>> = null;
    if (toolspaceGrant) {
      try {
        toolspace = await prepareToolspaceMcpSurface({ deps: routeDeps, grant });
      } catch (error) {
        if (error instanceof McpPayloadTooLargeError) {
          throw new HTTPException(413, { message: "MCP tool list exceeds the safety limit" });
        }
        throw error;
      }
    }
    const workspace = await getWorkspace(routeDeps.db, workspaceId);
    const workspaceMemoryEnabled = resolveWorkspaceMemoryEnabled(workspace?.settings);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const mcp = buildOpenGeniMcpServer(routeDeps, grant, {
      requestOrigin: new URL(c.req.url).origin,
      toolspace,
      workspaceMemoryEnabled,
    });
    try {
      await mcp.connect(transport);
      return await transport.handleRequest(boundedRequest);
    } finally {
      await toolspace?.close().catch(() => undefined);
    }
  });

  registerFileRoutes(app, routeDeps);
  registerApiKeyRoutes(app, routeDeps);
  registerBillingRoutes(app, routeDeps);
  registerDocumentRoutes(app, routeDeps);
  registerGitHubRoutes(app, routeDeps);
  registerInstallRoutes(app, routeDeps);
  registerWorkspaceRoutes(app, routeDeps);
  registerInsightsRoutes(app, routeDeps);
  registerWorkspaceInstructionPolicyRoutes(app, routeDeps);
  registerWorkspaceStateRoutes(app, routeDeps);
  registerPreferenceRegistryRoutes(app, routeDeps);
  registerSocialRoutes(app, routeDeps);
  registerConnectionRoutes(app, routeDeps);
  registerCapabilityRoutes(app, routeDeps);
  registerCatalogAssetRoutes(app, routeDeps);
  registerEnrollmentRoutes(app, routeDeps);
  registerMachineRoutes(app, routeDeps);
  registerEnvironmentRoutes(app, routeDeps);
  registerRigRoutes(app, routeDeps);
  registerPackRoutes(app, routeDeps);
  registerSessionRoutes(app, routeDeps);
  registerScheduledTaskRoutes(app, routeDeps);
  registerCodexRoutes(app, routeDeps);
  registerTranscriptionRoutes(app, routeDeps);

  app.notFound((c) => {
    if (!new URL(c.req.url).pathname.startsWith("/v1/")) return c.text("Not Found", 404);
    const requestId = correlationIds.get(c.req.raw) ?? crypto.randomUUID();
    return c.json(
      ErrorEnvelope.parse({
        error: {
          status: 404,
          code: "not_found",
          message: "Resource not found.",
          retryable: false,
          requestId,
        },
      }),
      404,
    );
  });

  app.onError((error, c) => {
    const compactionLock = codexCompactionV2ProviderLockedError(error);
    const status = compactionLock ? 422 : httpStatusForError(error);
    const code: ErrorCode = compactionLock ? compactionLock.code : errorCodeForStatus(status);
    const requestId = correlationIds.get(c.req.raw) ?? crypto.randomUUID();
    c.header(OPENGENI_CORRELATION_HEADER, requestId);
    if (new URL(c.req.url).pathname.startsWith("/v1/")) {
      c.header(OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION);
    }
    const envelope = ErrorEnvelope.parse({
      error: {
        status,
        code,
        message: compactionLock
          ? (boundedPublicMessage(compactionLock.message) ?? "Request failed.")
          : publicErrorMessage(error, status),
        retryable: retryableHttpStatus(status),
        requestId,
      },
    });
    return c.json(envelope, status as ContentfulStatusCode);
  });

  return app;
}

async function requireMcpAccessGrant(
  c: Parameters<typeof requireAccessGrant>[0],
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<AccessGrant> {
  const grant = await requireAccessGrant(c, deps, workspaceId);
  if (hasPermission(grant.permissions, "workspace:read")) {
    return grant;
  }
  if (isToolspaceGrant(deps.settings, grant)) {
    return grant;
  }
  // A worker-signed session-bound grant is allowed to reach the transport
  // without inheriting broad workspace read access. The exact session
  // authorization seam runs immediately after this gate, and tool registration
  // still exposes only capabilities permitted by the delegated grant.
  if (grant.metadata?.delegated === true && typeof grant.metadata.sessionId === "string") {
    return grant;
  }
  requirePermission(grant, "workspace:read");
  return grant;
}

function clientAuthConfig(settings: AppDependencies["settings"]) {
  if (settings.productAccessMode === "managed") {
    return { mode: "managedSession" as const, session: "cookie" as const };
  }
  if (settings.productAccessMode === "configured") {
    return {
      mode: "configuredToken" as const,
      headerName: "authorization" as const,
      scheme: "bearer" as const,
    };
  }
  if (settings.authRequired) {
    return {
      mode: "deploymentKey" as const,
      headerName: "x-opengeni-access-key" as const,
    };
  }
  return { mode: "none" as const };
}

function structuredServicesHint(backend: string): {
  fileSystem: boolean;
  git: boolean;
  terminalEvents: boolean;
} {
  const hasBox = backend !== "none";
  return { fileSystem: hasBox, git: hasBox, terminalEvents: hasBox };
}

export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}

function codexCompactionV2ProviderLockedError(
  error: unknown,
): CodexCompactionV2ProviderLockedError | null {
  if (error instanceof CodexCompactionV2ProviderLockedError) return error;
  if (
    error instanceof HTTPException &&
    error.cause instanceof CodexCompactionV2ProviderLockedError
  ) {
    return error.cause;
  }
  return null;
}

export function httpStatusForError(error: unknown): number {
  if (codexCompactionV2ProviderLockedError(error)) {
    return 422;
  }
  if (error instanceof HTTPException) {
    return error.status;
  }
  if (error instanceof McpPayloadTooLargeError) {
    return 413;
  }
  return 500;
}

export function errorCodeForStatus(status: number): ErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 402) return "payment_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413 || status === 422 || status === 400) return "validation_failed";
  if (status === 429) return "limit_exceeded";
  if (status === 502 || status === 503 || status === 504) return "upstream_unavailable";
  return "internal_error";
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function publicErrorMessage(error: unknown, status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return "OpenGeni is temporarily unavailable — retry.";
  }
  if (status >= 500) {
    return "OpenGeni could not complete the request.";
  }
  if (error instanceof HTTPException) {
    return boundedPublicMessage(error.message) ?? "Request failed.";
  }
  if (error instanceof McpPayloadTooLargeError) {
    return "Request payload is too large.";
  }
  return "Request failed.";
}

function boundedPublicMessage(value: string): string | null {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!normalized) return null;
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.byteLength <= API_PUBLIC_ERROR_MESSAGE_MAX_BYTES) return normalized;
  return new TextDecoder().decode(bytes.slice(0, API_PUBLIC_ERROR_MESSAGE_MAX_BYTES)).trim();
}

function boundedCorrelationId(value: string | undefined): string | null {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) return null;
  return value;
}

type ReadinessCheckName = "db" | "nats" | "temporal";
type ReadinessCheck = () => Promise<void> | void;
type ReadinessChecks = Record<ReadinessCheckName, ReadinessCheck>;
type ReadinessCheckResult = { ok: boolean; error?: string };

function readinessChecks(deps: AppDependencies): ReadinessChecks {
  return {
    db:
      deps.readinessChecks?.db ??
      (async () => {
        await deps.db.execute(dbSql`select 1`);
      }),
    nats:
      deps.readinessChecks?.nats ??
      (() => {
        if (deps.bus.isConnected && !deps.bus.isConnected()) {
          throw new Error("NATS is not connected");
        }
      }),
    temporal:
      deps.readinessChecks?.temporal ??
      deps.workflowClient.check ??
      (() => {
        throw new Error("Temporal readiness check unavailable");
      }),
  };
}

async function runReadinessChecks<const Checks extends Readonly<Record<string, ReadinessCheck>>>(
  checks: Checks,
  timeoutMs: number,
): Promise<{
  ok: boolean;
  checks: { [Name in keyof Checks]: ReadinessCheckResult };
}> {
  const entries = await Promise.all(
    (Object.entries(checks) as Array<[keyof Checks, ReadinessCheck]>).map(async ([name, check]) => {
      try {
        await withTimeout(Promise.resolve().then(check), timeoutMs);
        return [name, { ok: true }] as const;
      } catch (error) {
        return [
          name,
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        ] as const;
      }
    }),
  );
  const result = Object.fromEntries(entries) as { [Name in keyof Checks]: ReadinessCheckResult };
  return {
    ok: Object.values(result).every((check) => check.ok),
    checks: result,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`readiness check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const routeLabelPatterns: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/healthz$/, label: "/healthz" },
  { pattern: /^\/readyz$/, label: "/readyz" },
  { pattern: /^\/traffic-readyz$/, label: "/traffic-readyz" },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/codex\/connect\/start$/,
    label: "/v1/workspaces/:workspaceId/codex/connect/start",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/codex\/connect\/poll$/,
    label: "/v1/workspaces/:workspaceId/codex/connect/poll",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/codex\/status$/,
    label: "/v1/workspaces/:workspaceId/codex/status",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/codex\/usage$/,
    label: "/v1/workspaces/:workspaceId/codex/usage",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/codex$/,
    label: "/v1/workspaces/:workspaceId/codex",
  },
  { pattern: /^\/metrics$/, label: "/metrics" },
  { pattern: /^\/v1\/config\/client$/, label: "/v1/config/client" },
  { pattern: /^\/v1\/billing$/, label: "/v1/billing" },
  { pattern: /^\/v1\/billing\/checkout$/, label: "/v1/billing/checkout" },
  { pattern: /^\/v1\/billing\/usage$/, label: "/v1/billing/usage" },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/insights$/,
    label: "/v1/workspaces/:workspaceId/insights",
  },
  {
    pattern: /^\/v1\/billing\/entitlements$/,
    label: "/v1/billing/entitlements",
  },
  { pattern: /^\/v1\/webhooks\/stripe$/, label: "/v1/webhooks/stripe" },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/mcp$/,
    label: "/v1/workspaces/:workspaceId/mcp",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/mcp\/docs$/,
    label: "/v1/workspaces/:workspaceId/mcp/docs",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/mcp\/files$/,
    label: "/v1/workspaces/:workspaceId/mcp/files",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/default-rig$/,
    label: "/v1/workspaces/:workspaceId/default-rig",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions$/,
    label: "/v1/workspaces/:workspaceId/sessions",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/control-events\/stream$/,
    label: "/v1/workspaces/:workspaceId/control-events/stream",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/control-events$/,
    label: "/v1/workspaces/:workspaceId/control-events",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/inference-control$/,
    label: "/v1/workspaces/:workspaceId/inference-control",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/events\/stream$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/events/stream",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/lineage$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/lineage",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/events$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/events",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/queue\/[^/]+\/(move|edit|steer|delete)$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/queue/:turnId/:action",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/queue$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/queue",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/composer-draft$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/composer-draft",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/(control|steer)$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/:controlAction",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/stream-capabilities$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/stream-capabilities",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/viewers\/[^/]+\/heartbeat$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/viewers/:viewerId/heartbeat",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/viewers\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/viewers/:viewerId",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/viewers$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/viewers",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/goal$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id/goal",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/sessions/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/files\/uploads$/,
    label: "/v1/workspaces/:workspaceId/files/uploads",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/files\/uploads\/[^/]+\/complete$/,
    label: "/v1/workspaces/:workspaceId/files/uploads/:id/complete",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/files\/[^/]+\/download-url$/,
    label: "/v1/workspaces/:workspaceId/files/:id/download-url",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/files\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/files/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/artifacts\/[^/]+\/content$/,
    label: "/v1/workspaces/:workspaceId/artifacts/:id/content",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/artifacts\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/artifacts/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/api-keys$/,
    label: "/v1/workspaces/:workspaceId/api-keys",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/api-keys\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/api-keys/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks$/,
    label: "/v1/workspaces/:workspaceId/scheduled-tasks",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/pause$/,
    label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/pause",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/resume$/,
    label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/resume",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/trigger$/,
    label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/trigger",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/runs$/,
    label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/runs",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/document-bases$/,
    label: "/v1/workspaces/:workspaceId/document-bases",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/documents\/[^/]+\/reindex$/,
    label: "/v1/workspaces/:workspaceId/document-bases/:id/documents/:documentId/reindex",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/documents\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/document-bases/:id/documents/:documentId",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/documents$/,
    label: "/v1/workspaces/:workspaceId/document-bases/:id/documents",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/search$/,
    label: "/v1/workspaces/:workspaceId/document-bases/:id/search",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/document-bases/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/knowledge\/search$/,
    label: "/v1/workspaces/:workspaceId/knowledge/search",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/knowledge\/memories\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/knowledge/memories/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/knowledge\/memories$/,
    label: "/v1/workspaces/:workspaceId/knowledge/memories",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/app$/,
    label: "/v1/workspaces/:workspaceId/github/app",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/repositories$/,
    label: "/v1/workspaces/:workspaceId/github/repositories",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/repositories\/sync$/,
    label: "/v1/workspaces/:workspaceId/github/repositories/sync",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/connect$/,
    label: "/v1/workspaces/:workspaceId/github/connect",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/installations\/select$/,
    label: "/v1/workspaces/:workspaceId/github/installations/select",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/installations\/[^/]+\/configure$/,
    label: "/v1/workspaces/:workspaceId/github/installations/:installationId/configure",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/installations$/,
    label: "/v1/workspaces/:workspaceId/github/installations",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/installations\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/github/installations/:installationId",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/github\/app-manifest$/,
    label: "/v1/workspaces/:workspaceId/github/app-manifest",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/capabilities$/,
    label: "/v1/workspaces/:workspaceId/capabilities",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/capabilities\/discovery\/mcp-registry$/,
    label: "/v1/workspaces/:workspaceId/capabilities/discovery/mcp-registry",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/capabilities\/[^/]+\/enable$/,
    label: "/v1/workspaces/:workspaceId/capabilities/:id/enable",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/capabilities\/[^/]+\/disable$/,
    label: "/v1/workspaces/:workspaceId/capabilities/:id/disable",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/environments$/,
    label: "/v1/workspaces/:workspaceId/environments",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/environments\/[^/]+\/variables\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/environments/:id/variables/:name",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/environments\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/environments/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/packs$/,
    label: "/v1/workspaces/:workspaceId/packs",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/packs\/installations$/,
    label: "/v1/workspaces/:workspaceId/packs/installations",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/packs\/marketing-social-daily-analysis\/scheduled-tasks$/,
    label: "/v1/workspaces/:workspaceId/packs/marketing-social-daily-analysis/scheduled-tasks",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/packs\/[^/]+\/enable$/,
    label: "/v1/workspaces/:workspaceId/packs/:id/enable",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/packs\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/packs/:id",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/social\/connections$/,
    label: "/v1/workspaces/:workspaceId/social/connections",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/social\/posts$/,
    label: "/v1/workspaces/:workspaceId/social/posts",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/connections$/,
    label: "/v1/workspaces/:workspaceId/connections",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/connections\/oauth\/start$/,
    label: "/v1/workspaces/:workspaceId/connections/oauth/start",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/connections\/slack-bot\/install$/,
    label: "/v1/workspaces/:workspaceId/connections/slack-bot/install",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/connections\/[^/]+$/,
    label: "/v1/workspaces/:workspaceId/connections/:connectionId",
  },
  { pattern: /^\/v1\/catalog-assets\/.+$/, label: "/v1/catalog-assets/*" },
  {
    pattern: /^\/v1\/integrations\/oauth\/callback$/,
    label: "/v1/integrations/oauth/callback",
  },
  {
    pattern: /^\/v1\/integrations\/oauth\/client-metadata\.json$/,
    label: "/v1/integrations/oauth/client-metadata.json",
  },
  {
    pattern: /^\/v1\/integrations\/slack\/callback$/,
    label: "/v1/integrations/slack/callback",
  },
  {
    pattern: /^\/v1\/enrollments\/device\/start$/,
    label: "/v1/enrollments/device/start",
  },
  {
    pattern: /^\/v1\/enrollments\/device\/poll$/,
    label: "/v1/enrollments/device/poll",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/enrollments\/device\/approve$/,
    label: "/v1/workspaces/:workspaceId/enrollments/device/approve",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/enrollments\/[^/]+\/revoke$/,
    label: "/v1/workspaces/:workspaceId/enrollments/:id/revoke",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/enrollments$/,
    label: "/v1/workspaces/:workspaceId/enrollments",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/machines\/[^/]+\/metrics\/series$/,
    label: "/v1/workspaces/:workspaceId/machines/:enrollmentId/metrics/series",
  },
  {
    pattern: /^\/v1\/workspaces\/[^/]+\/machines$/,
    label: "/v1/workspaces/:workspaceId/machines",
  },
  {
    pattern: /^\/v1\/github\/app-manifest\/callback$/,
    label: "/v1/github/app-manifest/callback",
  },
  { pattern: /^\/v1\/github\/setup$/, label: "/v1/github/setup" },
  {
    pattern: /^\/v1\/github\/install\/callback$/,
    label: "/v1/github/install/callback",
  },
  {
    pattern: /^\/v1\/github\/oauth\/callback$/,
    label: "/v1/github/oauth/callback",
  },
];

export function routeLabel(pathname: string): string {
  const match = routeLabelPatterns.find(({ pattern }) => pattern.test(pathname));
  if (match) {
    return match.label;
  }
  return pathname.startsWith("/v1/") ? "/v1/unknown" : "/unknown";
}

/**
 * State-changing OpenGeni HTTP calls must never cross an incompatible rollout
 * boundary. Standard third-party protocols and externally initiated callbacks
 * are intentionally outside this product API contract.
 */
export function isApiContractProtectedMutation(method: string, pathname: string): boolean {
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method.toUpperCase())) {
    return false;
  }
  if (!pathname.startsWith("/v1/")) {
    return false;
  }
  if (
    pathname.startsWith("/v1/auth/") ||
    pathname.startsWith("/v1/webhooks/") ||
    pathname.startsWith("/v1/integrations/oauth/") ||
    pathname.startsWith("/v1/github/") ||
    pathname === "/v1/enrollments/device/start" ||
    pathname === "/v1/enrollments/device/poll" ||
    pathname === "/v1/enrollments/token/exchange"
  ) {
    return false;
  }
  return !pathname.split("/").includes("mcp");
}
