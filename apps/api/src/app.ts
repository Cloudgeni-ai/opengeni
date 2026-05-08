import {
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
} from "@infra-agents/config";
import { ClientConfig } from "@infra-agents/contracts";
import { createDocumentServices, indexDocumentNow, type DocumentServices } from "@infra-agents/documents";
import { createObjectStorage } from "@infra-agents/storage";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps, AppDependencies, ObjectStorageDependency, SessionWorkflowClient } from "./dependencies";
import { buildInfraAgentsMcpServer } from "./mcp/server";
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

  app.use("*", cors({
    origin: (origin) => {
      if (!origin) {
        return null;
      }
      return allowedCorsOrigin(deps.settings.corsAllowOriginRegex, origin) ? origin : null;
    },
  }));

  app.get("/healthz", (c) => c.json({
    service: deps.settings.serviceName,
    environment: deps.settings.environment,
    ok: true,
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
    const mcp = buildInfraAgentsMcpServer(routeDeps);
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
