import {
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  type Settings,
} from "@infra-agents/config";
import {
  ClientConfig,
  ClientSessionEvent,
  CompleteFileUploadResponse,
  AddDocumentRequest,
  CreateDocumentBaseRequest,
  CreateFileUploadRequest,
  CreateFileUploadResponse,
  Document,
  DocumentBase,
  DocumentSearchRequest,
  CreateSessionRequest,
  FileAsset,
  FileDownloadUrlResponse,
  GitHubAppManifestCreate,
  type ResourceRef,
  type SessionEvent,
  type ToolRef,
} from "@infra-agents/contracts";
import {
  appendAndPublishEvents,
  formatSse,
  type EventBus,
} from "@infra-agents/events";
import {
  completeFileUpload,
  appendSessionEventsWithLockedSessionUpdate,
  createFileUpload,
  createSession,
  getFileUpload,
  requireFile,
  getSession,
  listSessionEvents,
  markFileUploadFailed,
  requireSession,
  setTemporalWorkflowId,
  type AppendEventInput,
  type Database,
} from "@infra-agents/db";
import {
  buildGitHubAppManifest,
  convertGitHubAppManifest,
  createSignedState,
  envLinesFromGitHubManifestConversion,
  GitHubAppApiError,
  GitHubAppConfigurationError,
  githubAppMissingSettings,
  listGitHubAppRepositories,
  organizationAppManifestUrl,
  personalAppManifestUrl,
  verifySignedState,
} from "@infra-agents/github";
import {
  addDocumentToBase,
  createDocumentServices,
  createDocumentBase,
  type DocumentServices,
  getDocument,
  getDocumentChunk,
  getDocumentBase,
  indexDocumentNow,
  listDocumentBases,
  listDocuments,
  searchDocuments,
} from "@infra-agents/documents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { createObjectStorage } from "@infra-agents/storage";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

export type SessionWorkflowClient = {
  startSessionWorkflow: (input: { sessionId: string; initialEventId: string; workflowId: string }) => Promise<void>;
  signalUserMessage: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  signalApprovalDecision: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  signalInterrupt: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
};

export type DocumentIndexClient = {
  indexDocument: (input: { documentId: string }) => Promise<Document | void>;
};

export type AppDependencies = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  documentIndexer?: DocumentIndexClient;
  documentServices?: DocumentServices;
  githubStateSecret?: string;
};

export function createApp(deps: AppDependencies): Hono {
  const { settings, db, bus, workflowClient } = deps;
  const githubStateSecret = deps.githubStateSecret ?? settings.githubAppManifestStateSecret ?? crypto.randomUUID();
  const objectStorage = createObjectStorage(settings);
  let documentServices: DocumentServices | null = deps.documentServices ?? null;
  const getDocumentServices = () => {
    documentServices ??= createDocumentServices(settings);
    return documentServices;
  };
  const documentIndexer = deps.documentIndexer ?? {
    indexDocument: async ({ documentId }) => {
      if (!objectStorage) throw new HTTPException(503, { message: "object storage is not configured" });
      return await indexDocumentNow(db, objectStorage, documentId, getDocumentServices());
    },
  };
  const app = new Hono();

  app.use("*", cors({
    origin: (origin) => {
      if (!origin) {
        return null;
      }
      return allowedCorsOrigin(settings.corsAllowOriginRegex, origin) ? origin : null;
    },
  }));

  app.get("/healthz", (c) => c.json({
    service: settings.serviceName,
    environment: settings.environment,
    ok: true,
  }));

  app.get("/v1/config/client", (c) => c.json(ClientConfig.parse({
    defaultModel: settings.openaiModel,
    allowedModels: configuredAllowedModels(settings),
    defaultReasoningEffort: settings.openaiReasoningEffort,
    allowedReasoningEfforts: configuredAllowedReasoningEfforts(settings),
    fileUploads: {
      enabled: objectStorage !== null,
      maxSizeBytes: objectStorage?.maxSinglePutSizeBytes ?? 5_000_000_000,
    },
  })));

  app.post("/v1/files/uploads", async (c) => {
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    const payload = CreateFileUploadRequest.parse(await c.req.json());
    if (payload.sizeBytes > objectStorage.maxSinglePutSizeBytes) {
      throw new HTTPException(413, { message: `file exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes` });
    }
    const fileId = crypto.randomUUID();
    const safeFilename = sanitizeFilename(payload.filename);
    const objectKey = `files/${fileId}/original/${safeFilename}`;
    const signed = await objectStorage.createPutUrl({
      key: objectKey,
      contentType: payload.contentType,
      ...(payload.sha256 ? { sha256: payload.sha256 } : {}),
    });
    const upload = await createFileUpload(db, {
      fileId,
      filename: payload.filename,
      safeFilename,
      contentType: payload.contentType,
      sizeBytes: payload.sizeBytes,
      sha256: payload.sha256 ?? null,
      bucket: objectStorage.bucket,
      objectKey,
      expiresAt: signed.expiresAt,
    });
    return c.json(CreateFileUploadResponse.parse({
      fileId: upload.file.id,
      uploadId: upload.uploadId,
      putUrl: signed.url,
      requiredHeaders: signed.requiredHeaders,
      expiresAt: upload.expiresAt,
      maxSizeBytes: objectStorage.maxSinglePutSizeBytes,
    }), 201);
  });

  app.post("/v1/files/uploads/:uploadId/complete", async (c) => {
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    const upload = await getFileUpload(db, c.req.param("uploadId"));
    if (!upload) {
      throw new HTTPException(404, { message: "file upload not found" });
    }
    if (upload.status !== "pending") {
      throw new HTTPException(409, { message: `file upload is ${upload.status}` });
    }
    if (upload.expiresAt.getTime() < Date.now()) {
      await markFileUploadFailed(db, upload.id, upload.file.id);
      throw new HTTPException(409, { message: "file upload has expired" });
    }
    const head = await objectStorage.headFile(upload.file).catch((error) => {
      throw new HTTPException(409, { message: `uploaded object is not available: ${error instanceof Error ? error.message : String(error)}` });
    });
    if (Number(head.ContentLength ?? -1) !== upload.file.sizeBytes) {
      await markFileUploadFailed(db, upload.id, upload.file.id);
      throw new HTTPException(422, { message: "uploaded object size does not match file metadata" });
    }
    if (upload.file.contentType && head.ContentType && head.ContentType !== upload.file.contentType) {
      await markFileUploadFailed(db, upload.id, upload.file.id);
      throw new HTTPException(422, { message: "uploaded object content type does not match file metadata" });
    }
    if (upload.file.sha256 && head.Metadata?.sha256 !== upload.file.sha256) {
      await markFileUploadFailed(db, upload.id, upload.file.id);
      throw new HTTPException(422, { message: "uploaded object checksum metadata does not match file metadata" });
    }
    const file = await completeFileUpload(db, upload.id);
    return c.json(CompleteFileUploadResponse.parse({ file }));
  });

  app.get("/v1/files/:fileId", async (c) => {
    const file = await requireFile(db, c.req.param("fileId")).catch(() => null);
    if (!file) {
      throw new HTTPException(404, { message: "file not found" });
    }
    return c.json(FileAsset.parse(file));
  });

  app.post("/v1/files/:fileId/download-url", async (c) => {
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    const file = await requireFile(db, c.req.param("fileId")).catch(() => null);
    if (!file) {
      throw new HTTPException(404, { message: "file not found" });
    }
    if (file.status !== "ready") {
      throw new HTTPException(409, { message: `file is ${file.status}` });
    }
    const signed = await objectStorage.createGetUrl({ key: file.objectKey });
    return c.json(FileDownloadUrlResponse.parse({
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    }));
  });

  app.post("/v1/document-bases", async (c) => {
    const payload = CreateDocumentBaseRequest.parse(await c.req.json());
    return c.json(DocumentBase.parse(await createDocumentBase(db, payload)), 201);
  });

  app.get("/v1/document-bases", async (c) => {
    return c.json((await listDocumentBases(db)).map((base) => DocumentBase.parse(base)));
  });

  app.get("/v1/document-bases/:baseId", async (c) => {
    const base = await getDocumentBase(db, c.req.param("baseId"));
    if (!base) throw new HTTPException(404, { message: "document base not found" });
    return c.json(DocumentBase.parse(base));
  });

  app.post("/v1/document-bases/:baseId/documents", async (c) => {
    if (!objectStorage) throw new HTTPException(503, { message: "object storage is not configured" });
    const payload = AddDocumentRequest.parse(await c.req.json());
    try {
      const document = await addDocumentToBase(db, { baseId: c.req.param("baseId"), fileId: payload.fileId });
      const wasCreated = document.status === "queued" && document.chunkCount === 0 && document.error === null;
      const indexed = document.status === "ready" ? document : (await documentIndexer.indexDocument({ documentId: document.id }) ?? document);
      return c.json(Document.parse(indexed), wasCreated ? 201 : 200);
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.get("/v1/document-bases/:baseId/documents", async (c) => {
    return c.json((await listDocuments(db, c.req.param("baseId"))).map((document) => Document.parse(document)));
  });

  app.post("/v1/documents/:documentId/reindex", async (c) => {
    if (!objectStorage) throw new HTTPException(503, { message: "object storage is not configured" });
    try {
      const document = await getDocument(db, c.req.param("documentId"));
      if (!document) throw new HTTPException(404, { message: "document not found" });
      return c.json(Document.parse(await documentIndexer.indexDocument({ documentId: document.id }) ?? document));
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw documentHttpException(error);
    }
  });

  app.post("/v1/document-bases/:baseId/search", async (c) => {
    const payload = DocumentSearchRequest.parse(await c.req.json());
    const base = await getDocumentBase(db, c.req.param("baseId"));
    if (!base) throw new HTTPException(404, { message: "document base not found" });
    return c.json({ results: await searchDocuments(db, { baseIds: [base.id], query: payload.query, limit: payload.limit }, getDocumentServices()) });
  });

  app.all("/v1/mcp/docs", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildDocumentsMcpServer(db, getDocumentServices());
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });

  app.get("/v1/github/app", (c) => {
    const missing = githubAppMissingSettings(settings);
    const slug = settings.githubAppSlug?.trim() || null;
    return c.json({
      configured: missing.length === 0,
      appId: settings.githubAppId ?? null,
      clientId: settings.githubClientId ?? null,
      appSlug: slug,
      installUrl: slug ? `https://github.com/apps/${slug}/installations/new` : null,
      missing,
    });
  });

  app.get("/v1/github/repositories", async (c) => {
    try {
      return c.json({ repositories: await listGitHubAppRepositories(settings) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, { message: JSON.stringify({ message: error.message, missing: error.missing }) });
      }
      throw new HTTPException(502, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/github/repositories/sync", async (c) => {
    try {
      return c.json({ repositories: await listGitHubAppRepositories(settings) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, { message: JSON.stringify({ message: error.message, missing: error.missing }) });
      }
      throw new HTTPException(502, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/github/app-manifest", async (c) => {
    const payload = GitHubAppManifestCreate.parse(await c.req.json());
    const baseUrl = (settings.githubAppManifestBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    const state = createSignedState(githubStateSecret);
    const appName = payload.appName?.trim() || "Infra Agents";
    const manifest = buildGitHubAppManifest({
      appName,
      baseUrl,
      public: payload.public,
      includeCiPermissions: payload.includeCiPermissions,
    });
    const organization = payload.organization?.trim();
    return c.json({
      actionUrl: organization ? organizationAppManifestUrl(organization, state) : personalAppManifestUrl(state),
      state,
      manifest,
    });
  });

  app.get("/v1/github/app-manifest/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code) {
      throw new HTTPException(400, { message: "missing GitHub manifest code" });
    }
    if (!state || !verifySignedState(state, githubStateSecret)) {
      throw new HTTPException(400, { message: "invalid or expired GitHub manifest state" });
    }
    try {
      const conversion = await convertGitHubAppManifest(code);
      const envLines = envLinesFromGitHubManifestConversion(conversion);
      const slug = String(conversion.slug ?? "");
      const installUrl = slug ? `https://github.com/apps/${slug}/installations/new` : "";
      return c.html(githubSuccessHtml(envLines, installUrl));
    } catch (error) {
      const message = error instanceof GitHubAppApiError ? error.message : String(error);
      throw new HTTPException(502, { message });
    }
  });

  app.post("/v1/sessions", async (c) => {
    const payload = CreateSessionRequest.parse(await c.req.json());
    const resources = normalizeResources(payload.resources);
    const tools = validateToolRefs(payload.tools, settings);
    validateGitHubRepositorySelection(resources);
    if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await validateFileResources(db, resources);
    const model = payload.model ?? settings.openaiModel;
    const reasoningEffort = payload.reasoningEffort ?? settings.openaiReasoningEffort;
    const session = await createSession(db, {
      initialMessage: payload.initialMessage,
      resources,
      tools,
      metadata: {
        ...payload.metadata,
        model,
        reasoningEffort,
      },
      model,
      sandboxBackend: payload.sandboxBackend ?? settings.sandboxBackend,
    });
    const initialPayload = {
      text: payload.initialMessage,
      ...(resources.length ? { resources } : {}),
      ...(tools.length ? { tools } : {}),
    };
    const events = await appendAndPublishEvents(db, bus, session.id, [
      { type: "session.created", payload: { status: "queued" } },
      {
        type: "user.message",
        payload: initialPayload,
        ...(payload.clientEventId ? { clientEventId: payload.clientEventId } : {}),
      },
      { type: "session.status.changed", payload: { status: "queued" } },
    ]);
    const userEvent = events.find((event) => event.type === "user.message");
    if (!userEvent) {
      throw new HTTPException(500, { message: "failed to append initial user event" });
    }
    const workflowId = workflowIdForSession(session.id);
    await workflowClient.startSessionWorkflow({ sessionId: session.id, initialEventId: userEvent.id, workflowId });
    await setTemporalWorkflowId(db, session.id, workflowId);
    return c.json(await requireSession(db, session.id), 202);
  });

  app.get("/v1/sessions/:sessionId", async (c) => {
    const session = await getSession(db, c.req.param("sessionId"));
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return c.json(session);
  });

  app.get("/v1/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, sessionId);
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 500);
    return c.json(await listSessionEvents(db, sessionId, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 500));
  });

  app.get("/v1/sessions/:sessionId/events/stream", async (c) => {
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, sessionId);
    const after = Number(c.req.query("after") ?? c.req.header("Last-Event-ID") ?? 0);
    return sseSessionStream(db, bus, sessionId, Number.isFinite(after) ? after : 0, c.req.raw.signal);
  });

  app.post("/v1/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const event = ClientSessionEvent.parse(await c.req.json());
    if (event.type === "user.message") {
      const requestedResources = normalizeResources(event.payload.resources ?? []);
      const requestedTools = validateToolRefs(event.payload.tools ?? [], settings);
      const requestedModel = event.payload.model ?? null;
      const requestedReasoningEffort = event.payload.reasoningEffort ?? null;
      if (requestedResources.some((resource) => resource.kind === "file") && !objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      await validateFileResources(db, requestedResources);
      const appended = await appendSessionEventsWithLockedSessionUpdate(db, sessionId, (lockedSession) => {
        if (lockedSession.status !== "idle") {
          throw new HTTPException(409, { message: `session is ${lockedSession.status}; cannot accept a new user message` });
        }
        validateGitHubRepositorySelection([...lockedSession.resources, ...requestedResources]);
        const nextResources = mergeResourceRefs(lockedSession.resources, requestedResources);
        const nextTools = mergeToolRefs(lockedSession.tools, requestedTools);
        const nextModel = requestedModel ?? lockedSession.model;
        const nextMetadata = requestedReasoningEffort
          ? { ...lockedSession.metadata, reasoningEffort: requestedReasoningEffort }
          : lockedSession.metadata;
        return {
          events: [
            {
              type: event.type,
              payload: {
                text: event.payload.text,
                ...(requestedResources.length ? { resources: requestedResources } : {}),
                ...(requestedTools.length ? { tools: requestedTools } : {}),
                ...(requestedModel ? { model: requestedModel } : {}),
                ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
              },
              ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
            },
            { type: "session.status.changed", payload: { status: "queued" } },
          ],
          update: {
            resources: nextResources,
            tools: nextTools,
            model: nextModel,
            metadata: nextMetadata,
            status: "queued",
            activeTurnId: null,
          },
        };
      }).then(async (events) => {
        await bus.publish(sessionId, events);
        return events;
      });
      const accepted = appended[0];
      if (!accepted) {
        throw new HTTPException(500, { message: "failed to append client event" });
      }
      const workflowId = workflowIdForSession(sessionId);
      await workflowClient.signalUserMessage({ sessionId, eventId: accepted.id, workflowId });
      return c.json(accepted, 202);
    }

    const session = await requireSession(db, sessionId);
    if (event.type === "user.approvalDecision" && session.status !== "requires_action") {
      throw new HTTPException(409, { message: `session is ${session.status}; no approval is pending` });
    }
    const eventsToAppend: AppendEventInput[] = [{
      type: event.type,
      payload: event.payload,
      ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
    }];
    const appended = await appendAndPublishEvents(db, bus, sessionId, eventsToAppend);
    const accepted = appended[0];
    if (!accepted) {
      throw new HTTPException(500, { message: "failed to append client event" });
    }
    const workflowId = workflowIdForSession(sessionId);
    if (event.type === "user.approvalDecision") {
      await workflowClient.signalApprovalDecision({ sessionId, eventId: accepted.id, workflowId });
    } else {
      await workflowClient.signalInterrupt({ sessionId, eventId: accepted.id, workflowId });
    }
    return c.json(accepted, 202);
  });

  return app;
}

export async function sseSessionStream(db: Database, bus: EventBus, sessionId: string, after: number, signal: AbortSignal): Promise<Response> {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let lastSent = after;
  let replaying = true;
  const buffered: SessionEvent[] = [];
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: async (rawController) => {
      controller = rawController;
      const send = async (event: SessionEvent) => {
        if (event.sequence <= lastSent) {
          return;
        }
        if (event.sequence > lastSent + 1) {
          const missing = await listSessionEvents(db, sessionId, lastSent, event.sequence - lastSent - 1);
          for (const missed of missing) {
            if (missed.sequence > lastSent) {
              controller.enqueue(encoder.encode(formatSse(missed)));
              lastSent = missed.sequence;
            }
          }
        }
        controller.enqueue(encoder.encode(formatSse(event)));
        lastSent = event.sequence;
      };

      unsubscribe = await bus.subscribe(sessionId, async (events) => {
        if (replaying) {
          buffered.push(...events);
          return;
        }
        for (const event of events.sort((a, b) => a.sequence - b.sequence)) {
          await send(event);
        }
      });

      await replaySessionEvents((cursor, limit) => listSessionEvents(db, sessionId, cursor, limit), send, after);
      replaying = false;
      for (const event of buffered.sort((a, b) => a.sequence - b.sequence)) {
        await send(event);
      }
      buffered.length = 0;
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel: () => {
      unsubscribe?.();
    },
  });

  signal.addEventListener("abort", () => {
    unsubscribe?.();
  }, { once: true });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}

export async function replaySessionEvents(
  loadPage: (after: number, limit: number) => Promise<SessionEvent[]>,
  send: (event: SessionEvent) => Promise<void>,
  after: number,
  pageSize = 1000,
): Promise<void> {
  let cursor = after;
  while (true) {
    const page = await loadPage(cursor, pageSize);
    if (page.length === 0) {
      return;
    }
    for (const event of page.sort((a, b) => a.sequence - b.sequence)) {
      await send(event);
      cursor = Math.max(cursor, event.sequence);
    }
    if (page.length < pageSize) {
      return;
    }
  }
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}

async function assertSessionExists(db: Database, sessionId: string): Promise<void> {
  if (!await getSession(db, sessionId)) {
    throw new HTTPException(404, { message: "session not found" });
  }
}

export function validateToolRefs(tools: ToolRef[], settings: Settings): ToolRef[] {
  const mcpServerIds = new Set(settings.mcpServers.map((server) => server.id));
  const selected = new Set<string>();
  const out: ToolRef[] = [];
  for (const tool of tools) {
    if (tool.kind !== "mcp") {
      throw new HTTPException(422, { message: `unsupported tool kind: ${(tool as { kind?: string }).kind}` });
    }
    if (!mcpServerIds.has(tool.id)) {
      throw new HTTPException(422, { message: `unknown MCP server id: ${tool.id}` });
    }
    if (selected.has(tool.id)) {
      continue;
    }
    selected.add(tool.id);
    out.push(tool);
  }
  return out;
}

export function normalizeResources(resources: ResourceRef[]): ResourceRef[] {
  const mountPaths = new Map<string, string>();
  const identities = new Map<string, string>();
  const seenResources = new Set<string>();
  const out: ResourceRef[] = [];
  for (const resource of resources) {
    let normalized: ResourceRef;
    if (resource.kind === "file") {
      const mountPath = normalizeMountPath(resource.mountPath ?? `files/${resource.fileId}`);
      normalized = {
        kind: "file",
        fileId: resource.fileId,
        mountPath,
      };
    } else {
      const url = parseResourceUrl(resource.uri);
      if (url.protocol !== "https:" || !url.hostname) {
        throw new HTTPException(422, { message: "repository resources must use HTTPS Git URLs" });
      }
      const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      const parts = path.split("/").filter(Boolean);
      if (parts.length < 2) {
        throw new HTTPException(422, { message: "repository URL must include owner and repo" });
      }
      const repo = parts.join("/");
      const mountPath = normalizeMountPath(resource.mountPath ?? `repos/${repo}`);
      normalized = {
        kind: "repository",
        uri: `https://${url.hostname.toLowerCase()}/${repo}.git`,
        ref: resource.ref.trim(),
        mountPath,
        ...(resource.subpath ? { subpath: normalizeMountPath(resource.subpath) } : {}),
        ...(resource.githubInstallationId ? { githubInstallationId: resource.githubInstallationId } : {}),
        ...(resource.githubRepositoryId ? { githubRepositoryId: resource.githubRepositoryId } : {}),
      };
    }
    const key = stableJson(normalized);
    const mounted = normalized.mountPath ? mountPaths.get(normalized.mountPath) : undefined;
    if (mounted && mounted !== key) {
      throw new HTTPException(422, { message: `duplicate resource mount path: ${normalized.mountPath}` });
    }
    if (normalized.mountPath) {
      mountPaths.set(normalized.mountPath, key);
    }
    const identity = resourceIdentityKey(normalized);
    const seenIdentity = identities.get(identity);
    if (seenIdentity && seenIdentity !== key) {
      throw new HTTPException(422, { message: `duplicate resource with different settings: ${identity}` });
    }
    identities.set(identity, key);
    if (!seenResources.has(key)) {
      seenResources.add(key);
      out.push(normalized);
    }
  }
  return out;
}

export function mergeToolRefs(existing: ToolRef[], additions: ToolRef[]): ToolRef[] {
  const seen = new Set<string>();
  const out: ToolRef[] = [];
  for (const tool of [...existing, ...additions]) {
    const key = `${tool.kind}:${tool.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(tool);
  }
  return out;
}

export function mergeResourceRefs(existing: ResourceRef[], additions: ResourceRef[]): ResourceRef[] {
  const out = [...existing];
  const mountPaths = new Map(existing.flatMap((resource) => resource.mountPath ? [[resource.mountPath, stableJson(resource)] as const] : []));
  const identities = new Map(existing.map((resource) => [resourceIdentityKey(resource), stableJson(resource)] as const));
  const exact = new Set(existing.map(stableJson));

  for (const resource of additions) {
    const serialized = stableJson(resource);
    if (exact.has(serialized)) {
      continue;
    }
    const existingAtMount = resource.mountPath ? mountPaths.get(resource.mountPath) : undefined;
    if (existingAtMount && existingAtMount !== serialized) {
      throw new HTTPException(422, { message: `resource mount path is already attached: ${resource.mountPath}` });
    }
    const identity = resourceIdentityKey(resource);
    const existingIdentity = identities.get(identity);
    if (existingIdentity && existingIdentity !== serialized) {
      throw new HTTPException(422, { message: `resource is already attached with different settings: ${identity}` });
    }
    out.push(resource);
    exact.add(serialized);
    identities.set(identity, serialized);
    if (resource.mountPath) {
      mountPaths.set(resource.mountPath, serialized);
    }
  }
  return out;
}

export function validateGitHubRepositorySelection(resources: ResourceRef[]): void {
  const selected = resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const installationRaw = resource.githubInstallationId;
    const repositoryRaw = resource.githubRepositoryId;
    if (installationRaw === null && repositoryRaw === null) {
      return [];
    }
    if (installationRaw === undefined && repositoryRaw === undefined) {
      return [];
    }
    const installationId = positiveInteger(installationRaw);
    const repositoryId = positiveInteger(repositoryRaw);
    if (!installationId || !repositoryId) {
      throw new HTTPException(422, {
        message: "GitHub App repository resources require positive github_installation_id and github_repository_id",
      });
    }
    return [{ installationId, repositoryId }];
  });
  if (selected.length === 0) {
    return;
  }
  const installationId = selected[0]!.installationId;
  if (selected.some((item) => item.installationId !== installationId)) {
    throw new HTTPException(422, {
      message: "GitHub App repository resources must belong to one installation",
    });
  }
}

export async function validateFileResources(db: Database, resources: ResourceRef[]): Promise<void> {
  const fileIds = new Set<string>();
  for (const resource of resources) {
    if (resource.kind !== "file") {
      continue;
    }
    if (fileIds.has(resource.fileId)) {
      throw new HTTPException(422, { message: `duplicate file resource: ${resource.fileId}` });
    }
    fileIds.add(resource.fileId);
    const file = await requireFile(db, resource.fileId).catch(() => null);
    if (!file) {
      throw new HTTPException(422, { message: `unknown file resource: ${resource.fileId}` });
    }
    if (file.status !== "ready") {
      throw new HTTPException(422, { message: `file resource ${resource.fileId} is ${file.status}` });
    }
  }
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim().replace(/[/\\]/g, "_");
  const safe = trimmed.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\s+/g, " ").trim();
  return safe || "file";
}

function normalizeMountPath(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..")) {
    throw new HTTPException(422, { message: `invalid resource mount path: ${path}` });
  }
  return normalized;
}

function parseResourceUrl(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    throw new HTTPException(422, { message: "repository resources must use valid URLs" });
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}

function resourceIdentityKey(resource: ResourceRef): string {
  if (resource.kind === "file") {
    return `file:${resource.fileId}`;
  }
  return `repository:${resource.uri}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

function githubSuccessHtml(envLines: string[], installUrl: string): string {
  const envText = envLines.join("\n");
  const escaped = escapeHtml(envText);
  const install = installUrl ? `<a href="${escapeHtml(installUrl)}">Install on repositories</a>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Created</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(720px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}pre{white-space:pre-wrap;word-break:break-word;background:#09090b;border:1px solid #27272a;border-radius:8px;padding:16px}a{color:#fafafa}</style></head><body><main><h1>GitHub App created</h1><p>Add these values to .env, then restart API and worker.</p><pre>${escaped}</pre>${install}</main></body></html>`;
}

function buildDocumentsMcpServer(db: Database, documentServices: DocumentServices): McpServer {
  const server = new McpServer({ name: "infra-agents-documents", version: "1.0.0" });
  server.registerTool("list_document_bases", {
    description: "List available document bases.",
    inputSchema: {},
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(await listDocumentBases(db)) }],
  }));
  server.registerTool("search_documents", {
    description: "Search indexed documents.",
    inputSchema: {
      query: z.string(),
      baseIds: z.array(z.string()).optional(),
      limit: z.number().optional(),
    },
  }, async ({ query, baseIds, limit }) => ({
    content: [{ type: "text", text: JSON.stringify(await searchDocuments(db, {
      query,
      ...(baseIds ? { baseIds } : {}),
      ...(limit ? { limit } : {}),
    }, documentServices)) }],
  }));
  server.registerTool("fetch_document_chunk", {
    description: "Fetch one indexed document chunk.",
    inputSchema: {
      chunkId: z.string(),
    },
  }, async ({ chunkId }) => {
    const found = await getDocumentChunk(db, chunkId);
    return {
      content: [{ type: "text", text: found ? JSON.stringify(found) : `chunk not found: ${chunkId}` }],
      isError: !found,
    };
  });
  return server;
}

function documentHttpException(error: unknown): HTTPException {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) return new HTTPException(404, { message });
  if (message.includes("pending") || message.includes("failed") || message.includes("deleted")) return new HTTPException(422, { message });
  return new HTTPException(500, { message });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}
