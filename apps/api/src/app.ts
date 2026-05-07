import {
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  type Settings,
} from "@infra-agents/config";
import {
  ClientConfig,
  ClientSessionEvent,
  CreateSessionRequest,
  GitHubAppManifestCreate,
  type ResourceRef,
  type SessionEvent,
} from "@infra-agents/contracts";
import {
  appendAndPublishEvents,
  formatSse,
  type EventBus,
} from "@infra-agents/events";
import {
  createSession,
  getSession,
  listSessionEvents,
  requireSession,
  setSessionStatus,
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
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

export type SessionWorkflowClient = {
  startSessionWorkflow: (input: { sessionId: string; initialEventId: string; workflowId: string }) => Promise<void>;
  signalUserMessage: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  signalApprovalDecision: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  signalInterrupt: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
};

export type AppDependencies = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  githubStateSecret?: string;
};

export function createApp(deps: AppDependencies): Hono {
  const { settings, db, bus, workflowClient } = deps;
  const githubStateSecret = deps.githubStateSecret ?? settings.githubAppManifestStateSecret ?? crypto.randomUUID();
  const app = new Hono();

  app.use("*", cors({
    origin: (origin) => {
      if (!origin) {
        return null;
      }
      return new RegExp(settings.corsAllowOriginRegex).test(origin) ? origin : null;
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
  })));

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
    validateGitHubRepositorySelection(resources);
    const model = payload.model ?? settings.openaiModel;
    const reasoningEffort = payload.reasoningEffort ?? settings.openaiReasoningEffort;
    const session = await createSession(db, {
      initialMessage: payload.initialMessage,
      resources,
      metadata: {
        ...payload.metadata,
        model,
        reasoningEffort,
      },
      model,
      sandboxBackend: payload.sandboxBackend ?? settings.sandboxBackend,
    });
    const events = await appendAndPublishEvents(db, bus, session.id, [
      { type: "session.created", payload: { status: "queued" } },
      {
        type: "user.message",
        payload: { text: payload.initialMessage },
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
    const session = await requireSession(db, sessionId);
    const event = ClientSessionEvent.parse(await c.req.json());
    if (event.type === "user.message" && session.status !== "idle") {
      throw new HTTPException(409, { message: `session is ${session.status}; cannot accept a new user message` });
    }
    if (event.type === "user.approvalDecision" && session.status !== "requires_action") {
      throw new HTTPException(409, { message: `session is ${session.status}; no approval is pending` });
    }
    const eventsToAppend: AppendEventInput[] = [{
      type: event.type,
      payload: event.payload,
      ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
    }];
    if (event.type === "user.message") {
      eventsToAppend.push({ type: "session.status.changed", payload: { status: "queued" } });
    }
    const appended = await appendAndPublishEvents(db, bus, sessionId, eventsToAppend);
    const accepted = appended[0];
    if (!accepted) {
      throw new HTTPException(500, { message: "failed to append client event" });
    }
    const workflowId = workflowIdForSession(sessionId);
    if (event.type === "user.message") {
      await setSessionStatus(db, sessionId, "queued", null);
      await workflowClient.signalUserMessage({ sessionId, eventId: accepted.id, workflowId });
    } else if (event.type === "user.approvalDecision") {
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

      for (const event of await listSessionEvents(db, sessionId, after, 1000)) {
        await send(event);
      }
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

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}

async function assertSessionExists(db: Database, sessionId: string): Promise<void> {
  if (!await getSession(db, sessionId)) {
    throw new HTTPException(404, { message: "session not found" });
  }
}

export function normalizeResources(resources: ResourceRef[]): ResourceRef[] {
  const mountPaths = new Set<string>();
  return resources.map((resource) => {
    if (resource.kind !== "repository") {
      return resource;
    }
    const url = new URL(resource.uri);
    if (url.protocol !== "https:" || !url.hostname) {
      throw new HTTPException(422, { message: "repository resources must use HTTPS Git URLs" });
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new HTTPException(422, { message: "repository URL must include owner and repo" });
    }
    const repo = parts.join("/");
    const ref = typeof resource.metadata.ref === "string" && resource.metadata.ref.trim() ? resource.metadata.ref.trim() : "";
    if (!ref) {
      throw new HTTPException(422, { message: "repository resources require metadata.ref" });
    }
    const mountPath = `repos/${repo}`;
    if (mountPaths.has(mountPath)) {
      throw new HTTPException(422, { message: `duplicate repository mount path: ${mountPath}` });
    }
    mountPaths.add(mountPath);
    return {
      kind: "repository",
      uri: `https://${url.hostname.toLowerCase()}/${repo}.git`,
      metadata: {
        ...resource.metadata,
        host: url.hostname.toLowerCase(),
        repo,
        ref,
        subpath: typeof resource.metadata.subpath === "string" && resource.metadata.subpath.trim()
          ? resource.metadata.subpath.trim().replace(/^\/+|\/+$/g, "")
          : null,
        mount_path: mountPath,
      },
    };
  });
}

export function validateGitHubRepositorySelection(resources: ResourceRef[]): void {
  const selected = resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const installationRaw = resource.metadata.github_installation_id;
    const repositoryRaw = resource.metadata.github_repository_id;
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

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}

function githubSuccessHtml(envLines: string[], installUrl: string): string {
  const envText = envLines.join("\n");
  const escaped = escapeHtml(envText);
  const install = installUrl ? `<a href="${escapeHtml(installUrl)}">Install on repositories</a>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Created</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(720px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}pre{white-space:pre-wrap;word-break:break-word;background:#09090b;border:1px solid #27272a;border-radius:8px;padding:16px}a{color:#fafafa}</style></head><body><main><h1>GitHub App created</h1><p>Add these values to .env, then restart API and worker.</p><pre>${escaped}</pre>${install}</main></body></html>`;
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
