import {
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
} from "@opengeni/config";
import { ClientConfig } from "@opengeni/contracts";
import { createDocumentServices, indexDocumentNow, type DocumentServices } from "@opengeni/documents";
import { createObservability } from "@opengeni/observability";
import { createObjectStorage } from "@opengeni/storage";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps, AppDependencies, ObjectStorageDependency, SessionWorkflowClient } from "./dependencies";
import { requireAccessGrant } from "./access";
import { createManagedAuth } from "./auth/managed-auth";
import { requireLimit } from "./billing/limits";
import { buildOpenGeniMcpServer } from "./mcp/server";
import { requireAccessKey } from "./http/auth";
import { registerDocumentRoutes } from "./routes/documents";
import { registerFileRoutes } from "./routes/files";
import { registerApiKeyRoutes } from "./routes/api-keys";
import { registerBillingRoutes } from "./routes/billing";
import { registerGitHubRoutes } from "./routes/github";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { registerSessionRoutes } from "./routes/sessions";
import { registerWorkspaceRoutes } from "./routes/workspaces";

export type {
  ApiRouteDeps,
  AppDependencies,
  DocumentIndexClient,
  ObjectStorageDependency,
  SessionWorkflowClient,
} from "./dependencies";
export {
  mergeResourceRefs,
  mergeToolRefs,
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateGitHubRepositorySelectionShape,
  validateToolRefs,
} from "./domain/resources";
export { workflowIdForSession } from "./domain/sessions";
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
  const routeDeps: ApiRouteDeps = {
    ...deps,
    githubStateSecret: deps.githubStateSecret ?? deps.settings.githubAppManifestStateSecret ?? crypto.randomUUID(),
    managedAuth,
    objectStorage,
    documentIndexer,
    getDocumentServices,
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
    ok: true,
  }));

  app.get("/metrics", (c) => c.text(observability.prometheusMetrics(), 200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  }));

  app.get("/v1/config/client", (c) => c.json(ClientConfig.parse({
    deploymentRevision: deps.settings.deploymentRevision,
    defaultModel: deps.settings.openaiModel,
    allowedModels: configuredAllowedModels(deps.settings),
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
  })));

  app.all("/v1/workspaces/:workspaceId/mcp", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, routeDeps, workspaceId, "workspace:read");
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = buildOpenGeniMcpServer(routeDeps, grant);
    await mcp.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });

  registerFileRoutes(app, routeDeps);
  registerApiKeyRoutes(app, routeDeps);
  registerBillingRoutes(app, routeDeps);
  registerDocumentRoutes(app, routeDeps);
  registerGitHubRoutes(app, routeDeps);
  registerWorkspaceRoutes(app, routeDeps);
  registerSessionRoutes(app, routeDeps);
  registerScheduledTaskRoutes(app, routeDeps);

  return app;
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

export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}

export function httpStatusForError(error: unknown): number {
  if (error instanceof HTTPException) {
    return error.status;
  }
  return 500;
}

const routeLabelPatterns: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/healthz$/, label: "/healthz" },
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
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/events$/, label: "/v1/workspaces/:workspaceId/sessions/:id/events" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/turns\/reorder$/, label: "/v1/workspaces/:workspaceId/sessions/:id/turns/reorder" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/turns\/[^/]+$/, label: "/v1/workspaces/:workspaceId/sessions/:id/turns/:turnId" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/turns$/, label: "/v1/workspaces/:workspaceId/sessions/:id/turns" },
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
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/documents$/, label: "/v1/workspaces/:workspaceId/document-bases/:id/documents" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+\/search$/, label: "/v1/workspaces/:workspaceId/document-bases/:id/search" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/document-bases\/[^/]+$/, label: "/v1/workspaces/:workspaceId/document-bases/:id" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/app$/, label: "/v1/workspaces/:workspaceId/github/app" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/repositories$/, label: "/v1/workspaces/:workspaceId/github/repositories" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/repositories\/sync$/, label: "/v1/workspaces/:workspaceId/github/repositories/sync" },
  { pattern: /^\/v1\/workspaces\/[^/]+\/github\/app-manifest$/, label: "/v1/workspaces/:workspaceId/github/app-manifest" },
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
