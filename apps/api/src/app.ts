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
import { registerDocumentRoutes } from "./routes/documents";
import { registerFileRoutes } from "./routes/files";
import { registerGitHubRoutes } from "./routes/github";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { registerSessionRoutes } from "./routes/sessions";

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
      const durationSeconds = (performance.now() - start) / 1000;
      observability.recordHttpRequest({ method: c.req.method, route, status: 500, durationSeconds });
      span.end({
        attributes: {
          "http.response.status_code": 500,
          "opengeni.duration_ms": Math.round(durationSeconds * 1000),
        },
        error,
      });
      throw error;
    }
  });

  app.get("/healthz", (c) => c.json({
    service: deps.settings.serviceName,
    environment: deps.settings.environment,
    ok: true,
  }));

  app.get("/metrics", (c) => c.text(observability.prometheusMetrics(), 200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  }));

  app.get("/v1/config/client", (c) => c.json(ClientConfig.parse({
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
  })));

  app.all("/v1/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = buildOpenGeniMcpServer(routeDeps);
    await mcp.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });

  registerFileRoutes(app, routeDeps);
  registerDocumentRoutes(app, routeDeps);
  registerGitHubRoutes(app, routeDeps);
  registerSessionRoutes(app, routeDeps);
  registerScheduledTaskRoutes(app, routeDeps);

  return app;
}

export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}

function routeLabel(pathname: string): string {
  if (pathname.startsWith("/v1/sessions/") && pathname.endsWith("/events/stream")) {
    return "/v1/sessions/:id/events/stream";
  }
  if (pathname.startsWith("/v1/sessions/") && pathname.includes("/events")) {
    return "/v1/sessions/:id/events";
  }
  if (pathname.startsWith("/v1/sessions/")) {
    return "/v1/sessions/:id";
  }
  if (pathname.startsWith("/v1/files/uploads/")) {
    return "/v1/files/uploads/:id";
  }
  if (pathname.startsWith("/v1/files/") && pathname.endsWith("/download-url")) {
    return "/v1/files/:id/download-url";
  }
  return pathname;
}
