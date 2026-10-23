import {
  CreateEventSourceRequest,
  CreateEventSourceResponse,
  EVENT_DELIVERY_BODY_MAX_BYTES,
  EventSource,
  ListEventDeliveriesResponse,
  ListEventSourcesResponse,
  ListEventTypesResponse,
  ListInboundEventsResponse,
  ReplayEventDeliveryResponse,
  RotateEventSourceSecretResponse,
  SendTestEventRequest,
  SendTestEventResponse,
  UpdateEventSourceRequest,
} from "@opengeni/contracts";
import {
  createEventSourceForViewer,
  deleteEventSourceForViewer,
  eventSourceAccess,
  eventSourceForClient,
  GITHUB_WEBHOOK_PATH,
  listEventSourceTypes,
  receiveEventWebhook,
  receiveGitHubWebhook,
  replayEventDelivery,
  requireAccessGrant,
  requireEventSource,
  requireEventTriggersEnabled,
  rotateEventSourceSecret,
  scheduledTaskViewerForGrant,
  sendTestEvent,
  updateEventSourceForViewer,
  type ApiRouteDeps,
} from "@opengeni/core";
import { listEventDeliveries, listEventSources, listInboundEvents } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { githubAppWebhookPort } from "../github-access";
import { integrationBaseUrl } from "../integrations/oauth-client";
import { parseRequestJson, readBoundedRawBody } from "../http/request-body";

/**
 * Event sources: webhook endpoints and connected apps that deliver events into
 * a workspace, their delivery log and recent events, and the public webhook
 * intake. Automations point event triggers at a source.
 */
export function registerEventSourceRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;
  const baseUrl = (c: Context): string =>
    integrationBaseUrl(deps.settings.publicBaseUrl, c.req.url);

  async function viewerFor(
    c: Context,
    permission: "scheduled_tasks:run" | "scheduled_tasks:manage",
  ) {
    requireEventTriggersEnabled(deps.settings);
    const workspaceId = c.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    const viewer = await scheduledTaskViewerForGrant(db, grant, deps.settings);
    return { grant, viewer, workspaceId };
  }

  function sourceIdParam(c: Context): string {
    const sourceId = c.req.param("sourceId") ?? "";
    if (!z.string().uuid().safeParse(sourceId).success) {
      throw new HTTPException(404, { message: "event source not found" });
    }
    return sourceId;
  }

  function pageQuery(c: Context): { limit: number; cursor: string | null } {
    const limit = Number(c.req.query("limit") ?? 50);
    const cursor = c.req.query("cursor") ?? null;
    if (cursor !== null && cursor.length > 200)
      throw new HTTPException(400, { message: "invalid cursor" });
    return {
      limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50,
      cursor,
    };
  }

  app.get("/v1/workspaces/:workspaceId/event-sources", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:run");
    const sources = await listEventSources(db, workspaceId, viewer.subjectId);
    return c.json(
      ListEventSourcesResponse.parse({
        sources: sources
          .filter((source) => eventSourceAccess(viewer, source) !== "none")
          .map((source) => eventSourceForClient(source, baseUrl(c))),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/event-sources", async (c) => {
    const { grant, viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const request = await parseRequestJson(c, CreateEventSourceRequest);
    const created = await createEventSourceForViewer({
      db,
      settings: deps.settings,
      accountId: grant.accountId,
      workspaceId,
      createdBySubjectId: grant.subjectId,
      viewer,
      request,
      baseUrl: baseUrl(c),
      githubApp: request.kind === "github" ? githubAppWebhookPort(deps) : null,
    });
    c.header("cache-control", "private, no-store");
    return c.json(CreateEventSourceResponse.parse(created), 201);
  });

  app.get("/v1/workspaces/:workspaceId/event-sources/:sourceId", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:run");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "use");
    return c.json(EventSource.parse(eventSourceForClient(source, baseUrl(c))));
  });

  app.patch("/v1/workspaces/:workspaceId/event-sources/:sourceId", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "manage");
    const request = await parseRequestJson(c, UpdateEventSourceRequest);
    const updated = await updateEventSourceForViewer({
      db,
      settings: deps.settings,
      source,
      request,
      baseUrl: baseUrl(c),
    });
    return c.json(EventSource.parse(updated));
  });

  app.delete("/v1/workspaces/:workspaceId/event-sources/:sourceId", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "manage");
    await deleteEventSourceForViewer({ db, source });
    return c.json({ ok: true });
  });

  app.post("/v1/workspaces/:workspaceId/event-sources/:sourceId/rotate-secret", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "manage");
    const rotated = await rotateEventSourceSecret({ db, settings: deps.settings, source });
    c.header("cache-control", "private, no-store");
    return c.json(RotateEventSourceSecretResponse.parse(rotated));
  });

  app.post("/v1/workspaces/:workspaceId/event-sources/:sourceId/test", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "manage");
    const body = await c.req.json().catch(() => ({}));
    const parsed = SendTestEventRequest.safeParse(body ?? {});
    if (!parsed.success) throw new HTTPException(400, { message: "invalid test event" });
    const result = await sendTestEvent({ db, viewer, source, request: parsed.data });
    return c.json(SendTestEventResponse.parse(result), 201);
  });

  app.get("/v1/workspaces/:workspaceId/event-sources/:sourceId/deliveries", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:run");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "use");
    const page = await listEventDeliveries(db, workspaceId, source.id, pageQuery(c));
    return c.json(ListEventDeliveriesResponse.parse(page));
  });

  app.post(
    "/v1/workspaces/:workspaceId/event-sources/:sourceId/deliveries/:deliveryId/replay",
    async (c) => {
      const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
      const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "manage");
      const deliveryId = c.req.param("deliveryId");
      if (!z.string().uuid().safeParse(deliveryId).success) {
        throw new HTTPException(404, { message: "event delivery not found" });
      }
      const delivery = await replayEventDelivery({
        db,
        settings: deps.settings,
        source,
        deliveryId,
      });
      return c.json(ReplayEventDeliveryResponse.parse({ delivery }), 201);
    },
  );

  app.get("/v1/workspaces/:workspaceId/event-sources/:sourceId/events", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:run");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "use");
    const page = await listInboundEvents(db, workspaceId, {
      sourceIds: [source.id],
      ...pageQuery(c),
    });
    return c.json(ListInboundEventsResponse.parse(page));
  });

  app.get("/v1/workspaces/:workspaceId/event-sources/:sourceId/event-types", async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:run");
    const source = await requireEventSource(db, viewer, workspaceId, sourceIdParam(c), "use");
    const eventTypes = await listEventSourceTypes({
      db,
      settings: deps.settings,
      source,
      githubApp: source.kind === "github" ? githubAppWebhookPort(deps) : null,
    });
    return c.json(ListEventTypesResponse.parse({ sourceId: source.id, eventTypes }));
  });

  // The deployment's GitHub App sends every webhook here. The App's webhook
  // secret authenticates GitHub; each delivery goes to the GitHub source of
  // every workspace bound to its installation and repository.
  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    const body = await readBoundedRawBody(
      c.req.raw,
      EVENT_DELIVERY_BODY_MAX_BYTES,
      "webhook payload is too large",
    );
    const result = await receiveGitHubWebhook({
      db,
      settings: deps.settings,
      headers: c.req.raw.headers,
      body,
    });
    switch (result.outcome) {
      case "not_found":
        return c.json({ error: "not found" }, 404);
      case "rejected":
        return c.json({ error: result.reason }, 401);
      case "unreadable":
        return c.json({ error: result.reason }, 400);
      case "received":
        return c.json({ deliveries: result.deliveries }, 200);
    }
  });

  // The public intake. The URL names the source; the signature authenticates
  // the sender. Unknown URLs and a deployment without event triggers are 404.
  app.post("/v1/webhooks/events/:routeId", async (c) => {
    const routeId = c.req.param("routeId");
    if (!z.string().uuid().safeParse(routeId).success) {
      return c.json({ error: "not found" }, 404);
    }
    const body = await readBoundedRawBody(
      c.req.raw,
      EVENT_DELIVERY_BODY_MAX_BYTES,
      "webhook payload is too large",
    );
    const result = await receiveEventWebhook({
      db,
      settings: deps.settings,
      routeId,
      headers: c.req.raw.headers,
      body,
    });
    switch (result.outcome) {
      case "not_found":
        return c.json({ error: "not found" }, 404);
      case "gone":
        // An MCP subscription that ended: the server must stop retrying.
        return c.json({ error: "subscription ended" }, 410);
      case "challenge":
        return c.json({ challenge: result.challenge }, 200);
      case "rejected":
        return c.json({ error: result.reason }, 401);
      case "stored":
        return result.delivery.status === "failed"
          ? c.json({ error: result.delivery.reason, deliveryId: result.delivery.id }, 400)
          : c.json({ deliveryId: result.delivery.id, status: result.delivery.status }, 200);
    }
  });
}
