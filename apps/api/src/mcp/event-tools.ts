import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EventSourceRef,
  isReadyEventSourceKey,
  type AccessGrant,
  type EventTypeDescriptor,
  type ScheduledTask,
} from "@opengeni/contracts";
import {
  addReadyEventSource,
  eventSourceAccess,
  eventTriggersEnabled,
  listEventSourceTypes,
  listReadyEventSources,
  requireEventSource,
  scheduledTaskViewerForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getEventRunOccurrence, getInboundEvents, listEventSources } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";
import { githubAppWebhookPort } from "../github-access";

type JsonResult = (value: unknown) => { content: Array<{ type: "text"; text: string }> };

/** Event summaries one events_get page returns for a run. */
const RUN_EVENTS_PAGE_SIZE = 50;

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

function sourceForModel(source: {
  id: string;
  name: string;
  kind: string;
  adapter: string | null;
  status: string;
  statusReason: string | null;
  lastDeliveryAt: Date | null;
}) {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    ...(source.adapter ? { adapter: source.adapter } : {}),
    status: source.status,
    ...(source.statusReason ? { statusReason: source.statusReason } : {}),
    lastEventAt: source.lastDeliveryAt?.toISOString() ?? null,
  };
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
        return json({
          source: sourceForModel(source),
          eventTypes: eventTypes.map(eventTypeForModel),
        });
      }
      const [sources, ready] = await Promise.all([
        listEventSources(deps.db, grant.workspaceId, reader.subjectId).then((all) =>
          all.filter((source) => eventSourceAccess(reader, source) !== "none").map(sourceForModel),
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
              note: "No event sources are available yet. A person adds webhook, GitHub and Slack sources in Automations, and connecting an app whose MCP server offers events makes it ready here; tell the user which app's events this needs.",
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
}
