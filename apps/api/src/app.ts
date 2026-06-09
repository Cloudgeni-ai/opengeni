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
import { buildOpenGeniMcpServer } from "./mcp/server";
import { settingsWithEnabledCapabilityMcpServers } from "./domain/capabilities";
import { requireAccessKey } from "./http/auth";
import { registerCapabilityRoutes } from "./routes/capabilities";
import { registerDocumentRoutes } from "./routes/documents";
import { registerFileRoutes } from "./routes/files";
import { registerGitHubRoutes } from "./routes/github";
import { registerPackRoutes } from "./routes/packs";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSocialRoutes } from "./routes/social";

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
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
} from "./domain/resources";
export { workflowIdForSession } from "./domain/sessions";
export { replaySessionEvents, sseSessionStream } from "./http/sse";

export function createApp(deps: AppDependencies): Hono {
  const objectStorage = createObjectStorage(deps.settings);
  let documentServices: DocumentServices | null = deps.documentServices ?? null;
  const getDocumentServices = () => {
    documentServices ??= createDocumentServices(deps.settings);
    return documentServices;
  };
  const documentIndexer = deps.documentIndexer ?? {
    indexDocument: async ({ documentId }: { documentId: string }) => {
      if (!objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      return await indexDocumentNow(deps.db, objectStorage, documentId, getDocumentServices());
    },
  };
  const routeDeps: ApiRouteDeps = {
    ...deps,
    githubStateSecret: deps.githubStateSecret ?? deps.settings.githubAppManifestStateSecret ?? crypto.randomUUID(),
    objectStorage,
    documentIndexer,
    getDocumentServices,
  };
  const app = new Hono();
  const observability = deps.observability ?? createObservability(deps.settings, { component: "api" });

  app.use("*", cors({
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
      throw error;
    }
  });

  app.use("*", requireAccessKey(deps.settings));

  app.get("/healthz", (c) => c.json({
    service: deps.settings.serviceName,
    environment: deps.settings.environment,
    ok: true,
  }));

  app.get("/metrics", (c) => c.text(observability.prometheusMetrics(), 200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  }));

  app.get("/v1/config/client", async (c) => {
    const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(deps.db, deps.settings);
    return c.json(ClientConfig.parse({
      defaultModel: deps.settings.openaiModel,
      allowedModels: configuredAllowedModels(deps.settings),
      defaultReasoningEffort: deps.settings.openaiReasoningEffort,
      allowedReasoningEfforts: configuredAllowedReasoningEfforts(deps.settings),
      mcpServers: runtimeSettings.mcpServers.map((server) => ({
        id: server.id,
        name: server.name ?? server.id,
      })),
      fileUploads: {
        enabled: objectStorage !== null,
        maxSizeBytes: objectStorage?.maxSinglePutSizeBytes ?? 5_000_000_000,
      },
      auth: {
        required: deps.settings.authRequired,
        headerName: "authorization",
        scheme: "bearer",
      },
    }));
  });

  app.all("/v1/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = buildOpenGeniMcpServer(routeDeps);
    await mcp.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });

  registerFileRoutes(app, routeDeps);
  registerDocumentRoutes(app, routeDeps);
  registerGitHubRoutes(app, routeDeps);
  registerSocialRoutes(app, routeDeps);
  registerCapabilityRoutes(app, routeDeps);
  registerPackRoutes(app, routeDeps);
  registerSessionRoutes(app, routeDeps);
  registerScheduledTaskRoutes(app, routeDeps);

  return app;
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
  { pattern: /^\/v1\/mcp$/, label: "/v1/mcp" },
  { pattern: /^\/v1\/mcp\/docs$/, label: "/v1/mcp/docs" },
  { pattern: /^\/v1\/capabilities$/, label: "/v1/capabilities" },
  { pattern: /^\/v1\/capabilities\/discovery\/mcp-registry$/, label: "/v1/capabilities/discovery/mcp-registry" },
  { pattern: /^\/v1\/capabilities\/[^/]+\/enable$/, label: "/v1/capabilities/:id/enable" },
  { pattern: /^\/v1\/capabilities\/[^/]+\/disable$/, label: "/v1/capabilities/:id/disable" },
  { pattern: /^\/v1\/sessions$/, label: "/v1/sessions" },
  { pattern: /^\/v1\/sessions\/[^/]+\/events\/stream$/, label: "/v1/sessions/:id/events/stream" },
  { pattern: /^\/v1\/sessions\/[^/]+\/events$/, label: "/v1/sessions/:id/events" },
  { pattern: /^\/v1\/sessions\/[^/]+\/turns\/reorder$/, label: "/v1/sessions/:id/turns/reorder" },
  { pattern: /^\/v1\/sessions\/[^/]+\/turns\/[^/]+$/, label: "/v1/sessions/:id/turns/:turnId" },
  { pattern: /^\/v1\/sessions\/[^/]+\/turns$/, label: "/v1/sessions/:id/turns" },
  { pattern: /^\/v1\/sessions\/[^/]+$/, label: "/v1/sessions/:id" },
  { pattern: /^\/v1\/files\/uploads$/, label: "/v1/files/uploads" },
  { pattern: /^\/v1\/files\/uploads\/[^/]+\/complete$/, label: "/v1/files/uploads/:id/complete" },
  { pattern: /^\/v1\/files\/[^/]+\/download-url$/, label: "/v1/files/:id/download-url" },
  { pattern: /^\/v1\/files\/[^/]+$/, label: "/v1/files/:id" },
  { pattern: /^\/v1\/scheduled-tasks$/, label: "/v1/scheduled-tasks" },
  { pattern: /^\/v1\/scheduled-tasks\/[^/]+\/pause$/, label: "/v1/scheduled-tasks/:id/pause" },
  { pattern: /^\/v1\/scheduled-tasks\/[^/]+\/resume$/, label: "/v1/scheduled-tasks/:id/resume" },
  { pattern: /^\/v1\/scheduled-tasks\/[^/]+\/trigger$/, label: "/v1/scheduled-tasks/:id/trigger" },
  { pattern: /^\/v1\/scheduled-tasks\/[^/]+\/runs$/, label: "/v1/scheduled-tasks/:id/runs" },
  { pattern: /^\/v1\/scheduled-tasks\/[^/]+$/, label: "/v1/scheduled-tasks/:id" },
  { pattern: /^\/v1\/packs$/, label: "/v1/packs" },
  { pattern: /^\/v1\/packs\/installations$/, label: "/v1/packs/installations" },
  { pattern: /^\/v1\/packs\/[^/]+\/scheduled-tasks$/, label: "/v1/packs/:id/scheduled-tasks" },
  { pattern: /^\/v1\/packs\/[^/]+\/enable$/, label: "/v1/packs/:id/enable" },
  { pattern: /^\/v1\/packs\/[^/]+$/, label: "/v1/packs/:id" },
  { pattern: /^\/v1\/social\/connections$/, label: "/v1/social/connections" },
  { pattern: /^\/v1\/social\/posts$/, label: "/v1/social/posts" },
  { pattern: /^\/v1\/document-bases$/, label: "/v1/document-bases" },
  { pattern: /^\/v1\/document-bases\/[^/]+\/documents$/, label: "/v1/document-bases/:id/documents" },
  { pattern: /^\/v1\/document-bases\/[^/]+\/search$/, label: "/v1/document-bases/:id/search" },
  { pattern: /^\/v1\/document-bases\/[^/]+$/, label: "/v1/document-bases/:id" },
  { pattern: /^\/v1\/documents\/[^/]+\/reindex$/, label: "/v1/documents/:id/reindex" },
  { pattern: /^\/v1\/knowledge\/search$/, label: "/v1/knowledge/search" },
  { pattern: /^\/v1\/knowledge\/memories$/, label: "/v1/knowledge/memories" },
  { pattern: /^\/v1\/knowledge\/memories\/[^/]+$/, label: "/v1/knowledge/memories/:id" },
  { pattern: /^\/v1\/github\/app$/, label: "/v1/github/app" },
  { pattern: /^\/v1\/github\/repositories$/, label: "/v1/github/repositories" },
  { pattern: /^\/v1\/github\/repositories\/sync$/, label: "/v1/github/repositories/sync" },
  { pattern: /^\/v1\/github\/app-manifest$/, label: "/v1/github/app-manifest" },
  { pattern: /^\/v1\/github\/app-manifest\/callback$/, label: "/v1/github/app-manifest/callback" },
];

export function routeLabel(pathname: string): string {
  const match = routeLabelPatterns.find(({ pattern }) => pattern.test(pathname));
  if (match) {
    return match.label;
  }
  return pathname.startsWith("/v1/") ? "/v1/unknown" : "/unknown";
}
