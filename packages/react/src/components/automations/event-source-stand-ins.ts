/**
 * Sources a person can pick before they have them: the host's MCP servers and
 * this workspace's own events, such as its meetings. Neither needs setting
 * up, so each stands in for the person's own source until it is used, and
 * that source is added the first time its events are read or an automation
 * is saved on it.
 */
import { useCallback, useMemo, useRef } from "react";

import type { EventSource, EventTypeDescriptor, OpenGeniClient } from "@opengeni/sdk";

import { useOpenGeniText } from "../../messages/runtime";
import type { EventTriggersDraft } from "./event-trigger-model";

/** An MCP server whose events people can pick without adding a source first. */
export interface AutomationEventServer {
  /** The MCP server id as configured for the workspace. */
  serverId: string;
  /** Its name in the source picker. Default: the server id. */
  name?: string | undefined;
}

export interface EventSourceStandInsOptions {
  /** Adds a stand-in's source and reads event types. */
  client: Pick<OpenGeniClient, "createEventSource" | "listEventSourceTypes">;
  workspaceId: string;
  /** The sources the person can use; undefined while they load. */
  sources: EventSource[] | undefined;
  /** MCP servers whose events people can pick right away, such as the host's own. */
  eventServers?: readonly AutomationEventServer[] | undefined;
  /** Offer this workspace's own events, such as a meeting's transcript being ready. */
  workspaceEvents?: boolean | undefined;
}

export interface EventSourceStandIns {
  /** The person's sources, then a stand-in for each one they don't have yet. */
  sources: EventSource[] | undefined;
  /** Reads a source's event types; a stand-in's source is added first. */
  loadEventTypes: (sourceId: string) => Promise<EventTypeDescriptor[]>;
  /** The triggers on the person's own sources, adding the source behind any stand-in. */
  realEvents: (events: EventTriggersDraft) => Promise<EventTriggersDraft>;
  /** True when a trigger is on a stand-in, so the host reads its sources again after saving. */
  usesStandIn: (events: EventTriggersDraft) => boolean;
}

const SERVER_PREFIX = "mcp-server:";
const WORKSPACE_STAND_IN = "workspace-source:";

function isStandIn(sourceId: string): boolean {
  return sourceId.startsWith(SERVER_PREFIX) || sourceId === WORKSPACE_STAND_IN;
}

function standIn(
  workspaceId: string,
  fields: Pick<EventSource, "id" | "kind" | "name" | "mcp">,
): EventSource {
  return {
    workspaceId,
    adapter: null,
    ownerSubjectId: null,
    visibility: "private",
    status: "active",
    statusReason: null,
    webhookUrl: null,
    awaitingSigningSecret: false,
    lastDeliveryAt: null,
    createdAt: "",
    updatedAt: "",
    ...fields,
  };
}

/** The sources a trigger can point at, with stand-ins for the ones added on first use. */
export function useEventSourceStandIns({
  client,
  workspaceId,
  sources,
  eventServers,
  workspaceEvents = false,
}: EventSourceStandInsOptions): EventSourceStandIns {
  const t = useOpenGeniText();
  const workspaceName = t("automations.source.workspace.name");
  const withStandIns = useMemo(() => {
    if (!sources) return undefined;
    const extra: EventSource[] = [];
    for (const server of eventServers ?? []) {
      if (
        sources.some((source) => source.kind === "mcp" && source.mcp?.serverId === server.serverId)
      )
        continue;
      extra.push(
        standIn(workspaceId, {
          id: `${SERVER_PREFIX}${server.serverId}`,
          kind: "mcp",
          name: server.name ?? server.serverId,
          mcp: { serverId: server.serverId, connectionId: null },
        }),
      );
    }
    if (workspaceEvents && !sources.some((source) => source.kind === "workspace")) {
      extra.push(
        standIn(workspaceId, {
          id: WORKSPACE_STAND_IN,
          kind: "workspace",
          name: workspaceName,
          mcp: null,
        }),
      );
    }
    return extra.length > 0 ? [...sources, ...extra] : sources;
  }, [eventServers, sources, workspaceEvents, workspaceId, workspaceName]);

  // One creation per stand-in, shared by every read and save that needs it.
  const adding = useRef(new Map<string, Promise<string>>());
  const realSourceId = useCallback(
    (sourceId: string): Promise<string> => {
      if (!isStandIn(sourceId)) return Promise.resolve(sourceId);
      let pending = adding.current.get(sourceId);
      if (!pending) {
        const serverId = sourceId.startsWith(SERVER_PREFIX)
          ? sourceId.slice(SERVER_PREFIX.length)
          : null;
        const name = serverId
          ? eventServers?.find((server) => server.serverId === serverId)?.name
          : undefined;
        pending = client
          .createEventSource(
            workspaceId,
            serverId ? { kind: "mcp", serverId, ...(name ? { name } : {}) } : { kind: "workspace" },
          )
          .then((created) => created.source.id);
        adding.current.set(sourceId, pending);
        pending.catch(() => adding.current.delete(sourceId));
      }
      return pending;
    },
    [client, eventServers, workspaceId],
  );
  const loadEventTypes = useCallback(
    async (sourceId: string) =>
      client.listEventSourceTypes(workspaceId, await realSourceId(sourceId)),
    [client, realSourceId, workspaceId],
  );
  const realEvents = useCallback(
    async (events: EventTriggersDraft): Promise<EventTriggersDraft> => ({
      ...events,
      triggers: await Promise.all(
        events.triggers.map(async (trigger) => ({
          ...trigger,
          sourceId: await realSourceId(trigger.sourceId),
        })),
      ),
    }),
    [realSourceId],
  );
  const usesStandIn = useCallback(
    (events: EventTriggersDraft) => events.triggers.some((trigger) => isStandIn(trigger.sourceId)),
    [],
  );
  return { sources: withStandIns, loadEventTypes, realEvents, usesStandIn };
}
