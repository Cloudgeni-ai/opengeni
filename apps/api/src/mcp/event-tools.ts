import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateEventSourceRequest,
  EventSourceName,
  EventSourceRef,
  EventSourceSigningSecretInput,
  EventSourceVisibility,
  isReadyEventSourceKey,
  WEBHOOK_FORMAT_PRESET_NAMES,
  WebhookFormat,
  webhookFormatOfPreset,
  type AccessGrant,
  type EventSource,
  type EventTypeDescriptor,
  type ScheduledTask,
  type WebhookFormatPreset,
  UpdateEventSourceRequest,
} from "@opengeni/contracts";
import {
  addReadyEventSource,
  createEventSourceForViewer,
  deleteEventSourceForViewer,
  eventSourceAccess,
  eventSourceWebhookUrl,
  eventTriggersEnabled,
  inboundWebhookBaseUrl,
  listEventSourceTypes,
  listReadyEventSources,
  requireEventSource,
  scheduledTaskViewerForGrant,
  updateEventSourceForViewer,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getEventRunOccurrence,
  getInboundEvents,
  listEventDeliveries,
  listEventSources,
  type EventSourceRecord,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";
import { githubAppWebhookPort } from "../github-access";

type JsonResult = (value: unknown) => { content: Array<{ type: "text"; text: string }> };

/** Event summaries one events_get page returns for a run. */
const RUN_EVENTS_PAGE_SIZE = 50;

/** Deliveries a webhook source's view shows, newest first, to check its setup. */
const RECENT_DELIVERIES = 5;

/**
 * A custom webhook's format as the tools take it: an object the event-triggers
 * Skill describes, checked against the full schema on use. Its JSON Schema
 * would put several kilobytes in every agent's tool list.
 */
const FormatInput = z4
  .record(z4.string(), z4.unknown())
  .optional()
  .describe("A custom webhook's format, as the event-triggers Skill describes");

/** A format the agent wrote, or a tool error that says what is wrong with it. */
function parseFormat(format: Record<string, unknown>): WebhookFormat {
  const parsed = WebhookFormat.safeParse(format);
  if (parsed.success) return parsed.data;
  throw new Error(`The format is not valid:\n${z4.prettifyError(parsed.error)}`);
}

/** What a trigger can name on a source, without empty fields. */
function eventTypeForModel(type: EventTypeDescriptor) {
  return {
    type: type.type,
    description: type.description,
    ...(type.fields.length > 0
      ? {
          fields: type.fields.map(({ field, description }) =>
            description ? { field, description } : { field },
          ),
        }
      : {}),
    ...(type.argumentsSchema ? { argumentsSchema: type.argumentsSchema } : {}),
    ...(type.available ? {} : { unavailable: type.unavailableReason ?? "Not available" }),
  };
}

function sourceForModel(
  source: Pick<
    EventSourceRecord,
    "id" | "name" | "kind" | "adapter" | "format" | "status" | "statusReason" | "lastDeliveryAt"
  > &
    Partial<Pick<EventSourceRecord, "routeId">>,
  webhookBaseUrl?: string | null,
) {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    ...(source.adapter ? { adapter: source.adapter } : {}),
    ...(source.format?.preset ? { preset: source.format.preset } : {}),
    ...(webhookBaseUrl && source.kind === "webhook" && source.routeId
      ? { webhookUrl: eventSourceWebhookUrl(webhookBaseUrl, source.routeId) }
      : {}),
    status: source.status,
    ...(source.statusReason ? { statusReason: source.statusReason } : {}),
    lastEventAt: source.lastDeliveryAt?.toISOString() ?? null,
  };
}

/**
 * What to give the sending app: the URL, and for an app that can't sign, the
 * URL with the secret in its query.
 */
function webhookRegistration(source: Pick<EventSource, "webhookUrl" | "format">) {
  if (!source.webhookUrl) {
    return {
      note: "This deployment has no public webhook address (OPENGENI_WEBHOOK_BASE_URL or OPENGENI_PUBLIC_BASE_URL), so apps can't reach the source yet.",
    };
  }
  const signature = source.format?.signature;
  return signature?.scheme === "url_token"
    ? {
        registerUrl: `${source.webhookUrl}?${signature.parameter}=<secret>`,
        note: "Give the app registerUrl with <secret> replaced by the same secret reference you passed as signingSecret.",
      }
    : { registerUrl: source.webhookUrl };
}

/**
 * The agent's read access to event sources and stored events. Creating and
 * changing triggers goes through scheduled_tasks_create and _update. Sources
 * that need no setting up are listed by key and added for the person the
 * first time they are used. Absent where the deployment does not run event
 * triggers.
 */
export function registerEventTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  json: JsonResult,
  requireVisibleTask: (id: string) => Promise<ScheduledTask>,
  /** The session may set up automations, so it may add a ready source by reading it. */
  canAddSources: boolean,
): void {
  if (!eventTriggersEnabled(deps.settings)) return;
  const viewer = () => scheduledTaskViewerForGrant(deps.db, grant, deps.settings);
  const network = {
    db: deps.db,
    settings: deps.settings,
    ...(deps.eventSourceFetch ? { fetch: deps.eventSourceFetch } : {}),
  };
  const notFound = (sourceId: string, cause?: unknown) =>
    new Error(`Event source not found: ${sourceId}`, cause ? { cause } : undefined);
  const webhookBaseUrl = inboundWebhookBaseUrl(deps.settings)?.replace(/\/+$/u, "") ?? null;
  // A person-facing failure (bad secret, source in use) as the tool's error.
  const plainError = (error: unknown): never => {
    if (error instanceof HTTPException) throw new Error(error.message, { cause: error });
    throw error;
  };
  const manageable = async (sourceId: string) =>
    await requireEventSource(deps.db, await viewer(), grant.workspaceId, sourceId, "manage").catch(
      (error: unknown) => {
        if (error instanceof HTTPException && error.status === 404) throw notFound(sourceId, error);
        return plainError(error);
      },
    );

  server.registerTool(
    "event_sources_list",
    {
      description:
        "List the event sources automations can trigger on: connected apps such as GitHub, Slack and Gmail, webhook endpoints, and MCP connections that offer events. readyToAdd lists sources that need no setup (MCP servers the user is signed in to that offer events, their Gmail, This workspace for meetings): a readyToAdd id works anywhere a source id does, and the user's source is added the first time it is used. Pass sourceId to get the event types that source offers, the fields conditions can match, and an MCP event type's subscription arguments. Use them in the events field of scheduled_tasks_create and scheduled_tasks_update.",
      inputSchema: { sourceId: EventSourceRef.optional() },
    },
    async ({ sourceId }) => {
      const reader = await viewer();
      if (sourceId) {
        let source: Awaited<ReturnType<typeof requireEventSource>>;
        if (isReadyEventSourceKey(sourceId)) {
          if (!canAddSources) throw notFound(sourceId);
          source = await addReadyEventSource(network, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            ownerSubjectId: reader.subjectId,
            createdBySubjectId: grant.subjectId,
            key: sourceId,
          }).catch((error: unknown) => {
            if (error instanceof HTTPException) throw new Error(error.message, { cause: error });
            throw error;
          });
        } else {
          source = await requireEventSource(
            deps.db,
            reader,
            grant.workspaceId,
            sourceId,
            "use",
          ).catch((error: unknown) => {
            if (error instanceof HTTPException && error.status === 404)
              throw notFound(sourceId, error);
            throw error;
          });
        }
        const eventTypes = await listEventSourceTypes({
          db: deps.db,
          settings: deps.settings,
          source,
          githubApp: source.kind === "github" ? githubAppWebhookPort(deps) : null,
          ...(deps.eventSourceFetch ? { fetch: deps.eventSourceFetch } : {}),
        });
        const manages = eventSourceAccess(reader, source) === "manage";
        const deliveries =
          source.kind === "webhook"
            ? (
                await listEventDeliveries(deps.db, grant.workspaceId, source.id, {
                  limit: RECENT_DELIVERIES,
                })
              ).deliveries
            : [];
        return json({
          source: {
            ...sourceForModel(source, webhookBaseUrl),
            ...(manages && source.format ? { format: source.format } : {}),
          },
          eventTypes: eventTypes.map(eventTypeForModel),
          ...(source.kind === "webhook"
            ? {
                recentDeliveries: deliveries.map((delivery) => ({
                  receivedAt: delivery.receivedAt,
                  status: delivery.status,
                  ...(delivery.reason ? { reason: delivery.reason } : {}),
                  ...(delivery.eventTypes.length > 0 ? { eventTypes: delivery.eventTypes } : {}),
                })),
              }
            : {}),
        });
      }
      const [sources, ready] = await Promise.all([
        listEventSources(deps.db, grant.workspaceId, reader.subjectId).then((all) =>
          all
            .filter((source) => eventSourceAccess(reader, source) !== "none")
            .map((source) => sourceForModel(source)),
        ),
        canAddSources
          ? listReadyEventSources(network, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              ownerSubjectId: reader.subjectId,
            })
          : Promise.resolve([]),
      ]);
      const readyToAdd = ready.map(({ key, name, kind }) => ({ id: key, name, kind }));
      return json({
        sources,
        ...(readyToAdd.length > 0 ? { readyToAdd } : {}),
        ...(sources.length === 0 && readyToAdd.length === 0
          ? {
              note: canAddSources
                ? "No event sources are available yet. A person adds GitHub and Slack sources in Automations, connecting an app whose MCP server offers events makes it ready here, and event_sources_create_webhook adds any other app's webhooks."
                : "No event sources are available yet. A person adds webhook, GitHub and Slack sources in Automations, and connecting an app whose MCP server offers events makes it ready here; tell the user which app's events this needs.",
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "events_get",
    {
      description:
        "Read stored events. Pass eventId for one event with all its stored data, or scheduledTaskRunId for the events an automation run carried, paged with offset. Events are kept for 30 days.",
      inputSchema: {
        eventId: z4.string().uuid().optional(),
        scheduledTaskRunId: z4.string().uuid().optional(),
        offset: z4.number().int().nonnegative().max(10_000).optional(),
      },
    },
    async ({ eventId, scheduledTaskRunId, offset }) => {
      if ((eventId === undefined) === (scheduledTaskRunId === undefined))
        throw new Error("Pass either eventId or scheduledTaskRunId");
      if (eventId) {
        const [event] = await getInboundEvents(deps.db, grant.workspaceId, [eventId]);
        const visible =
          event !== undefined &&
          (await requireEventSource(
            deps.db,
            await viewer(),
            grant.workspaceId,
            event.sourceId,
            "use",
          ).then(
            () => true,
            () => false,
          ));
        if (!event || !visible)
          throw new Error(`Event not found: ${eventId}. Events are kept for 30 days.`);
        return json({ event });
      }
      const run = await getEventRunOccurrence(deps.db, grant.workspaceId, scheduledTaskRunId!);
      if (!run) throw new Error(`Run ${scheduledTaskRunId} is not an event run`);
      await requireVisibleTask(run.taskId);
      const start = offset ?? 0;
      const events = run.occurrence.events.slice(start, start + RUN_EVENTS_PAGE_SIZE);
      const next = start + events.length;
      return json({
        scheduledTaskRunId,
        eventCount: run.occurrence.eventCount,
        events,
        ...(next < run.occurrence.events.length ? { nextOffset: next } : {}),
        ...(run.occurrence.events.length < run.occurrence.eventCount
          ? {
              note: `Only the first ${run.occurrence.events.length} of ${run.occurrence.eventCount} events were kept for this run.`,
            }
          : {}),
      });
    },
  );

  if (!canAddSources) return;

  /** A source as the agent sees it after a change, with what to give the app. */
  const changedSource = (source: EventSource) => ({
    source: {
      id: source.id,
      name: source.name,
      kind: source.kind,
      ...(source.format?.preset ? { preset: source.format.preset } : {}),
      status: source.status,
      ...(source.statusReason ? { statusReason: source.statusReason } : {}),
    },
    ...(source.kind === "webhook" ? webhookRegistration(source) : {}),
  });

  server.registerTool(
    "event_sources_create_webhook",
    {
      description:
        "Add a webhook source so another app's webhooks can start automations. Pass preset for Linear, Sentry or Tailscale; for any other app, write format from its webhook docs (how it signs deliveries, where the event type is), as the event-triggers Skill explains. Pass signingSecret as a saved secret's reference so the value stays out of the chat: the secret the app shows or that you set there, its public key for ed25519, or a secret you saved for an app that can't sign (url_token). Without it the source waits, refusing deliveries, until event_sources_update sets it. Give the app the returned registerUrl. Then check with event_sources_list and the sourceId that the app's deliveries are accepted.",
      inputSchema: {
        name: EventSourceName,
        preset: z4
          .enum(WEBHOOK_FORMAT_PRESET_NAMES as [WebhookFormatPreset, ...WebhookFormatPreset[]])
          .optional(),
        format: FormatInput,
        signingSecret: EventSourceSigningSecretInput.optional(),
        visibility: EventSourceVisibility.optional(),
      },
    },
    async ({ name, preset, format, signingSecret, visibility }) => {
      if ((preset === undefined) === (format === undefined))
        throw new Error("Pass either preset or format");
      const request = CreateEventSourceRequest.parse({
        kind: "webhook",
        adapter: "custom",
        name,
        format: format ? parseFormat(format) : webhookFormatOfPreset(preset!),
        ...(signingSecret !== undefined ? { signingSecret } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
      });
      const created = await createEventSourceForViewer({
        db: deps.db,
        settings: deps.settings,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        createdBySubjectId: grant.subjectId,
        viewer: await viewer(),
        request,
        baseUrl: webhookBaseUrl ?? "",
      }).catch(plainError);
      return json(changedSource(withoutUnroutableUrl(created.source)));
    },
  );

  server.registerTool(
    "event_sources_update",
    {
      description:
        "Change an event source you manage: rename it, share it with the workspace, turn it off or on, or, for a custom webhook, set its signing secret (as a saved secret's reference) or replace its format. Setting the first secret of a waiting webhook turns it on.",
      inputSchema: {
        sourceId: z4.string().uuid(),
        name: EventSourceName.optional(),
        visibility: EventSourceVisibility.optional(),
        status: z4.enum(["active", "disabled"]).optional(),
        signingSecret: EventSourceSigningSecretInput.optional(),
        format: FormatInput,
      },
    },
    async ({ sourceId, format, ...changes }) => {
      const patch: Record<string, unknown> = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      );
      if (format) patch.format = parseFormat(format);
      if (Object.keys(patch).length === 0) throw new Error("Pass at least one change");
      const updated = await updateEventSourceForViewer({
        db: deps.db,
        settings: deps.settings,
        source: await manageable(sourceId),
        request: UpdateEventSourceRequest.parse(patch),
        baseUrl: webhookBaseUrl ?? "",
      }).catch(plainError);
      return json(changedSource(withoutUnroutableUrl(updated)));
    },
  );

  server.registerTool(
    "event_sources_delete",
    {
      description:
        "Delete an event source you manage, with its stored deliveries and events. Remove the triggers automations have on it first.",
      inputSchema: { sourceId: z4.string().uuid() },
    },
    async ({ sourceId }) => {
      await deleteEventSourceForViewer({
        db: deps.db,
        source: await manageable(sourceId),
      }).catch(plainError);
      return json({ deleted: sourceId });
    },
  );

  /** Without a public base URL the client view's URL is relative, which no app can use. */
  function withoutUnroutableUrl(source: EventSource): EventSource {
    return webhookBaseUrl ? source : { ...source, webhookUrl: null };
  }
}
