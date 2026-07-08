import {
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  configuredModels,
} from "@opengeni/config";
import { ClientConfig, resolveWorkspaceMemoryEnabled, type AccessGrant } from "@opengeni/contracts";
import { createDocumentServices, indexDocumentNow, type DocumentServices } from "@opengeni/documents";
import { dbSql, getWorkspace } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { createObjectStorage } from "@opengeni/storage";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps, AppDependencies } from "@opengeni/core";
import { hasPermission, requireAccessGrant, requirePermission } from "@opengeni/core";
import { createManagedAuth } from "./auth/managed-auth";
import { createApiSandboxClient, makeResumeBoxById } from "./sandbox/access";
import { requireLimit } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "./mcp/server";
import { isToolspaceGrant, prepareToolspaceMcpSurface } from "./mcp/toolspace";
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
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSocialRoutes } from "./routes/social";
import { registerWorkspaceRoutes } from "./routes/workspaces";

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
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
} from "@opengeni/core";
export { workflowIdForSession } from "@opengeni/core";
export { replaySessionEvents, sseSessionStream } from "./http/sse";

export function createApp(deps: AppDependencies): Hono {
  const managedAuth = deps.managedAuth ?? createManagedAuth(deps.settings, deps.db);
  const objectStorage = createObjectStorage(deps.settings);
  let documentServices: DocumentServices | null = deps.documentServices ?? null;
  const getDocumentServices = () => {
    documentServices ??= createDocumentServices(deps.settings);
    return documentServices;
  };
  const documentIndexer = deps.documentIndexer ?? {
    indexDocument: async ({ accountId, workspaceId, documentId }: { accountId: string; workspaceId: string; documentId: string }) => {
      if (!objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      return await indexDocumentNow(deps.db, objectStorage, workspaceId, documentId, getDocumentServices(), {
        beforeEmbed: async ({ chunkCount }) => {
          await requireLimit(routeDeps, { accountId, workspaceId, action: "document:index", quantity: chunkCount });
        },
      });
    },
  };
  // The API process's own agent-loop-free sandbox client — the API-direct
  // control-plane seam. Constructed from settings (resumes boxes by id
  // in-process) unless a client was injected (tests). resumeBoxById is always
  // concrete for routes; it throws SandboxResumeError when sandboxBackend=none.
  const sandboxClient = deps.sandboxClient ?? createApiSandboxClient(deps.settings);
  const resumeBoxById = deps.resumeBoxById ?? makeResumeBoxById(sandboxClient);
  const routeDeps: ApiRouteDeps = {
    ...deps,
    githubStateSecret: deps.githubStateSecret ?? deps.settings.githubAppManifestStateSecret ?? crypto.randomUUID(),
    managedAuth,
    objectStorage,
    documentIndexer,
    getDocumentServices,
    ...(sandboxClient ? { sandboxClient } : {}),
    resumeBoxById,
  };
  const app = new Hono();
  const observability = deps.observability ?? createObservability(deps.settings, { component: "api" });

  app.use("*", cors({
    credentials: true,
    origin: (origin) => {
      if (!origin) {
        return null;
      }
      return allowedCorsOrigin(deps.settings.corsAllowOriginRegex, origin) ? origin : null;
    },
  }));

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const route = routeLabel(url.pathname);
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
      observability.recordHttpRequest({ method: c.req.method, route, status, durationSeconds });
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
      });
    } catch (error) {
      const status = httpStatusForError(error);
      const durationSeconds = (performance.now() - start) / 1000;
      observability.recordHttpRequest({ method: c.req.method, route, status, durationSeconds });
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
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  app.use("*", requireAccessKey(deps.settings));

  if (managedAuth) {
    app.on(["GET", "POST"], "/v1/auth/*", (c) => managedAuth.handler(c.req.raw));
  }

  app.get("/healthz", (c) => c.json({
    service: deps.settings.serviceName,
    environment: deps.settings.environment,
    deploymentRevision: deps.settings.deploymentRevision,
    ...(deps.settings.serverVersion ? { serverVersion: deps.settings.serverVersion } : {}),
    ok: true,
  }));

  app.get("/readyz", async (c) => {
    const result = await runReadinessChecks(readinessChecks(deps), 2_000);
    return c.json(result, result.ok ? 200 : 503);
  });

  app.get("/metrics", async (c) => c.text(await observability.prometheusMetrics(), 200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  }));

  app.get("/v1/config/client", (c) => c.json(ClientConfig.parse({
    deploymentRevision: deps.settings.deploymentRevision,
    ...(deps.settings.serverVersion ? { serverVersion: deps.settings.serverVersion } : {}),
    defaultModel: deps.settings.openaiModel,
    allowedModels: configuredAllowedModels(deps.settings),
    // Provider-grouped model list for the picker. configuredModels() carries the
    // union of the built-in allow-list and every registry provider's models, in
    // selection order (default model first); project each to the client-safe
    // ClientModel shape (ConfiguredModel.providerId → ClientModel.provider).
    models: configuredModels(deps.settings).map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.providerId,
      providerLabel: model.providerLabel,
      api: model.api,
      ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
    })),
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
    productAccessMode: deps.settings.productAccessMode,
    auth: clientAuthConfig(deps.settings),
    // Channel-A structured services (P4.4) ride exec/readFile/createEditor,
    // available on every real backend; `none` has no box so they are all off.
    // Per-session availability is still negotiated on /stream-capabilities.
    structuredServices: structuredServicesHint(deps.settings.sandboxBackend),
  })));

  app.all("/v1/workspaces/:workspaceId/mcp", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireMcpAccessGrant(c, routeDeps, workspaceId);
    const toolspace = isToolspaceGrant(routeDeps.settings, grant)
      ? await prepareToolspaceMcpSurface({ deps: routeDeps, grant })
      : null;
    const workspace = await getWorkspace(routeDeps.db, workspaceId);
    const workspaceMemoryEnabled = resolveWorkspaceMemoryEnabled(workspace?.settings);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = buildOpenGeniMcpServer(routeDeps, grant, {
      requestOrigin: new URL(c.req.url).origin,
      toolspace,
      workspaceMemoryEnabled,
    });
    try {
      await mcp.connect(transport);
      return await transport.handleRequest(c.req.raw);
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
  registerSocialRoutes(app, routeDeps);
  registerConnectionRoutes(app, routeDeps);
  registerCapabilityRoutes(app, routeDeps);
  registerCatalogAssetRoutes(app, routeDeps);
  registerEnrollmentRoutes(app, routeDeps);
  registerMachineRoutes(app, routeDeps);
  registerEnvironmentRoutes(app, routeDeps);
  registerPackRoutes(app, routeDeps);
  registerSessionRoutes(app, routeDeps);
  registerScheduledTaskRoutes(app, routeDeps);
  registerCodexRoutes(app, routeDeps);

  return app;
}

async function requireMcpAccessGrant(c: Parameters<typeof requireAccessGrant>[0], deps: ApiRouteDeps, workspaceId: string): Promise<AccessGrant> {
  const grant = await requireAccessGrant(c, deps, workspaceId);
  if (hasPermission(grant.permissions, "workspace:read")) {
    return grant;
  }
  if (isToolspaceGrant(deps.settings, grant)) {
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
    return { mode: "configuredToken" as const, headerName: "authorization" as const, scheme: "bearer" as const };
  }
  if (settings.authRequired) {
    return { mode: "deploymentKey" as const, headerName: "x-opengeni-access-key" as const };
  }
  return { mode: "none" as const };
}

function structuredServicesHint(backend: string): { fileSystem: boolean; git: boolean; terminalEvents: boolean } {
  const hasBox = backend !== "none";
  return { fileSystem: hasBox, git: hasBox, terminalEvents: hasBox };
}

export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}

export function httpStatusForError(error: unknown): number {
  if (error instanceof HTTPException) {
    return error.status;
  }
  return 500;
}

type ReadinessCheckName = "db" | "nats" | "temporal";
type ReadinessChecks = Record<ReadinessCheckName, () => Promise<void> | void>;

function readinessChecks(deps: AppDependencies): ReadinessChecks {
  return {
    db: deps.readinessChecks?.db ?? (async () => {
      await deps.db.execute(dbSql`select 1`);
    }),
    nats: deps.readinessChecks?.nats ?? (() => {
      if (deps.bus.isConnected && !deps.bus.isConnected()) {
        throw new Error("NATS is not connected");
      }
    }),
    temporal: deps.readinessChecks?.temporal ?? deps.workflowClient.check ?? (() => {
      throw new Error("Temporal readiness check unavailable");
    }),
  };
}

async function runReadinessChecks(checks: ReadinessChecks, timeoutMs: number): Promise<{
  ok: boolean;
  checks: Record<ReadinessCheckName, { ok: boolean; error?: string }>;
}> {
  const entries = await Promise.all(
    (Object.entries(checks) as Array<[ReadinessCheckName, () => Promise<void> | void]>)
      .map(async ([name, check]) => {
        try {
          await withTimeout(Promise.resolve().then(check), timeoutMs);
          return [name, { ok: true }] as const;
        } catch (error) {
          return [name, { ok: false, error: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
  );
  const result = Object.fromEntries(entries) as Record<ReadinessCheckName, { ok: boolean; error?: string }>;
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
        timer = setTimeout(() => reject(new Error(`readiness check timed out after ${timeoutMs}ms`)), timeoutMs);
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
  { pattern: /^\/v1\/workspaces\/[^/]+\/codex\/connect\/start$/, label: "/v1/workspaces/:workspaceId/codex/connect/start" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/codex\/connect\/poll$/, label: "/v1/workspaces/:workspaceId/codex/connect/poll" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/codex\/status$/, label: "/v1/workspaces/:workspaceId/codex/status" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/codex\/usage$/, label: "/v1/workspaces/:workspaceId/codex/usage" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/codex$/, label: "/v1/workspaces/:workspaceId/codex" },
  { pattern: /^\/metrics$/, label: "/metrics" },
  { pattern: /^\/v1\/config\/client$/, label: "/v1/config/client" },
  { pattern: /^\/v1\/billing$/, label: "/v1/billing" },
  { pattern: /^\/v1\/billing\/checkout$/, label: "/v1/billing/checkout" },
  { pattern: /^\/v1\/billing\/usage$/, label: "/v1/billing/usage" },
  { pattern: /^\/v1\/billing\/entitlements$/, label: "/v1/billing/entitlements" },
  { pattern: /^\/v1\/webhooks\/stripe$/, label: "/v1/webhooks/stripe" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/mcp$/, label: "/v1/workspaces/:workspaceId/mcp" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/mcp\/docs$/, label: "/v1/workspaces/:workspaceId/mcp/docs" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions$/, label: "/v1/workspaces/:workspaceId/sessions" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/events\/stream$/, label: "/v1/workspaces/:workspaceId/sessions/:id/events/stream" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/lineage$/, label: "/v1/workspaces/:workspaceId/sessions/:id/lineage" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/events$/, label: "/v1/workspaces/:workspaceId/sessions/:id/events" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/turns\/reorder$/, label: "/v1/workspaces/:workspaceId/sessions/:id/turns/reorder" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/turns\/[^/]+$/, label: "/v1/workspaces/:workspaceId/sessions/:id/turns/:turnId" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/turns$/, label: "/v1/workspaces/:workspaceId/sessions/:id/turns" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/stream-capabilities$/, label: "/v1/workspaces/:workspaceId/sessions/:id/stream-capabilities" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/viewers\/[^/]+\/heartbeat$/, label: "/v1/workspaces/:workspaceId/sessions/:id/viewers/:viewerId/heartbeat" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/viewers\/[^/]+$/, label: "/v1/workspaces/:workspaceId/sessions/:id/viewers/:viewerId" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/viewers$/, label: "/v1/workspaces/:workspaceId/sessions/:id/viewers" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/goal$/, label: "/v1/workspaces/:workspaceId/sessions/:id/goal" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+$/, label: "/v1/workspaces/:workspaceId/sessions/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/files\/uploads$/, label: "/v1/workspaces/:workspaceId/files/uploads" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/files\/uploads\/[^/]+\/complete$/, label: "/v1/workspaces/:workspaceId/files/uploads/:id/complete" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/files\/[^/]+\/download-url$/, label: "/v1/workspaces/:workspaceId/files/:id/download-url" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/files\/[^/]+$/, label: "/v1/workspaces/:workspaceId/files/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/api-keys$/, label: "/v1/workspaces/:workspaceId/api-keys" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/api-keys\/[^/]+$/, label: "/v1/workspaces/:workspaceId/api-keys/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks$/, label: "/v1/workspaces/:workspaceId/scheduled-tasks" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/pause$/, label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/pause" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/resume$/, label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/resume" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/trigger$/, label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/trigger" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+\/runs$/, label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id/runs" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/scheduled-tasks\/[^/]+$/, label: "/v1/workspaces/:workspaceId/scheduled-tasks/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases$/, label: "/v1/workspaces/:workspaceId/document-bases" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/documents\/[^/]+\/reindex$/, label: "/v1/workspaces/:workspaceId/document-bases/:id/documents/:documentId/reindex" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/documents\/[^/]+$/, label: "/v1/workspaces/:workspaceId/document-bases/:id/documents/:documentId" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/documents$/, label: "/v1/workspaces/:workspaceId/document-bases/:id/documents" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/search$/, label: "/v1/workspaces/:workspaceId/document-bases/:id/search" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+$/, label: "/v1/workspaces/:workspaceId/document-bases/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/knowledge\/search$/, label: "/v1/workspaces/:workspaceId/knowledge/search" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/knowledge\/memories\/[^/]+$/, label: "/v1/workspaces/:workspaceId/knowledge/memories/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/knowledge\/memories$/, label: "/v1/workspaces/:workspaceId/knowledge/memories" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/app$/, label: "/v1/workspaces/:workspaceId/github/app" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/repositories$/, label: "/v1/workspaces/:workspaceId/github/repositories" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/repositories\/sync$/, label: "/v1/workspaces/:workspaceId/github/repositories/sync" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/app-manifest$/, label: "/v1/workspaces/:workspaceId/github/app-manifest" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/capabilities$/, label: "/v1/workspaces/:workspaceId/capabilities" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/capabilities\/discovery\/mcp-registry$/, label: "/v1/workspaces/:workspaceId/capabilities/discovery/mcp-registry" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/capabilities\/[^/]+\/enable$/, label: "/v1/workspaces/:workspaceId/capabilities/:id/enable" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/capabilities\/[^/]+\/disable$/, label: "/v1/workspaces/:workspaceId/capabilities/:id/disable" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/environments$/, label: "/v1/workspaces/:workspaceId/environments" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/environments\/[^/]+\/variables\/[^/]+$/, label: "/v1/workspaces/:workspaceId/environments/:id/variables/:name" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/environments\/[^/]+$/, label: "/v1/workspaces/:workspaceId/environments/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/packs$/, label: "/v1/workspaces/:workspaceId/packs" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/packs\/installations$/, label: "/v1/workspaces/:workspaceId/packs/installations" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/packs\/marketing-social-daily-analysis\/scheduled-tasks$/, label: "/v1/workspaces/:workspaceId/packs/marketing-social-daily-analysis/scheduled-tasks" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/packs\/[^/]+\/enable$/, label: "/v1/workspaces/:workspaceId/packs/:id/enable" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/packs\/[^/]+$/, label: "/v1/workspaces/:workspaceId/packs/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/social\/connections$/, label: "/v1/workspaces/:workspaceId/social/connections" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/social\/posts$/, label: "/v1/workspaces/:workspaceId/social/posts" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/connections$/, label: "/v1/workspaces/:workspaceId/connections" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/connections\/oauth\/start$/, label: "/v1/workspaces/:workspaceId/connections/oauth/start" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/connections\/[^/]+$/, label: "/v1/workspaces/:workspaceId/connections/:connectionId" },
  { pattern: /^\/v1\/catalog-assets\/.+$/, label: "/v1/catalog-assets/*" },
  { pattern: /^\/v1\/integrations\/oauth\/callback$/, label: "/v1/integrations/oauth/callback" },
  { pattern: /^\/v1\/integrations\/oauth\/client-metadata\.json$/, label: "/v1/integrations/oauth/client-metadata.json" },
  { pattern: /^\/v1\/enrollments\/device\/start$/, label: "/v1/enrollments/device/start" },
  { pattern: /^\/v1\/enrollments\/device\/poll$/, label: "/v1/enrollments/device/poll" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/enrollments\/device\/approve$/, label: "/v1/workspaces/:workspaceId/enrollments/device/approve" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/enrollments\/[^/]+\/revoke$/, label: "/v1/workspaces/:workspaceId/enrollments/:id/revoke" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/enrollments$/, label: "/v1/workspaces/:workspaceId/enrollments" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/machines\/[^/]+\/metrics\/series$/, label: "/v1/workspaces/:workspaceId/machines/:enrollmentId/metrics/series" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/machines$/, label: "/v1/workspaces/:workspaceId/machines" },
  { pattern: /^\/v1\/github\/app-manifest\/callback$/, label: "/v1/github/app-manifest/callback" },
  { pattern: /^\/v1\/github\/setup$/, label: "/v1/github/setup" },
  { pattern: /^\/v1\/github\/install\/callback$/, label: "/v1/github/install/callback" },
  { pattern: /^\/v1\/github\/oauth\/callback$/, label: "/v1/github/oauth/callback" },
];

export function routeLabel(pathname: string): string {
  const match = routeLabelPatterns.find(({ pattern }) => pattern.test(pathname));
  if (match) {
    return match.label;
  }
  return pathname.startsWith("/v1/") ? "/v1/unknown" : "/unknown";
}
