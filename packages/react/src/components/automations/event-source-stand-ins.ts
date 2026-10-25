/**
 * Sources a person can pick before they have them: the ones the server lists
 * as ready (MCP servers they are signed in to that offer events, their Gmail
 * accounts and this workspace's own events), and the host's own MCP servers.
 * None needs setting up, so each stands in for the person's own source until
 * it is used, and that source is added the first time its events are read or
 * an automation is saved on it.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import {
  readyEventSourceKey,
  readyEventSourceRequest,
  type ReadyEventSourceKind,
} from "@opengeni/contracts/event-triggers";
import type {
  EventSource,
  EventTypeDescriptor,
  OpenGeniClient,
  ReadyEventSource,
} from "@opengeni/sdk";

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
  /** What the server lists as ready to use (`listReadyEventSources`). */
  readySources?: readonly ReadyEventSource[] | undefined;
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

/** A stand-in's id is the ready source's key, which never looks like a source id. */
function isStandIn(sourceId: string): boolean {
  return readyEventSourceRequest(sourceId) !== null;
}

function standIn(
  workspaceId: string,
  ready: { key: string; kind: ReadyEventSourceKind; name: string },
): EventSource {
  const request = readyEventSourceRequest(ready.key);
  return {
    id: ready.key,
    workspaceId,
    kind: ready.kind,
    adapter: null,
    name: ready.name,
    ownerSubjectId: null,
    visibility: "private",
    status: "active",
    statusReason: null,
    statusReasonCode: null,
    statusReasonDetail: null,
    webhookUrl: null,
    awaitingSigningSecret: false,
    mcp: request?.kind === "mcp" ? { serverId: request.serverId, connectionId: null } : null,
    lastDeliveryAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

/** The sources a trigger can point at, with stand-ins for the ones added on first use. */
export function useEventSourceStandIns({
  client,
  workspaceId,
  sources,
  readySources,
  eventServers,
  workspaceEvents = false,
}: EventSourceStandInsOptions): EventSourceStandIns {
  const t = useOpenGeniText();
  const workspaceName = t("automations.source.workspace.name");
  // The source each used stand-in became: once the person has it, it shows instead.
  const [added, setAdded] = useState<ReadonlyMap<string, string>>(() => new Map());
  const withStandIns = useMemo(() => {
    if (!sources) return undefined;
    const ready = new Map<string, { key: string; kind: ReadyEventSourceKind; name: string }>();
    for (const entry of readySources ?? []) {
      if (entry.kind === "workspace" && !workspaceEvents) continue;
      ready.set(entry.key, entry);
    }
    for (const server of eventServers ?? []) {
      const key = readyEventSourceKey({ kind: "mcp", serverId: server.serverId });
      ready.set(key, {
        key,
        kind: "mcp",
        name: server.name ?? ready.get(key)?.name ?? server.serverId,
      });
    }
    if (workspaceEvents) {
      const key = readyEventSourceKey({ kind: "workspace" });
      ready.set(key, { key, kind: "workspace", name: workspaceName });
    }
    const has = (key: string, kind: ReadyEventSourceKind): boolean => {
      const id = added.get(key);
      if (id !== undefined && sources.some((source) => source.id === id)) return true;
      const request = readyEventSourceRequest(key);
      if (request?.kind === "mcp") {
        return sources.some(
          (source) => source.kind === "mcp" && source.mcp?.serverId === request.serverId,
        );
      }
      // A person has one This workspace source.
      return kind === "workspace" && sources.some((source) => source.kind === "workspace");
    };
    const extra = [...ready.values()]
      .filter((entry) => !has(entry.key, entry.kind))
      .map((entry) => standIn(workspaceId, entry));
    return extra.length > 0 ? [...sources, ...extra] : sources;
  }, [added, eventServers, readySources, sources, workspaceEvents, workspaceId, workspaceName]);

  // One creation per stand-in, shared by every read and save that needs it.
  const adding = useRef(new Map<string, Promise<string>>());
  const realSourceId = useCallback(
    (sourceId: string): Promise<string> => {
      const request = readyEventSourceRequest(sourceId);
      if (!request) return Promise.resolve(sourceId);
      let pending = adding.current.get(sourceId);
      if (!pending) {
        const name =
          request.kind === "mcp"
            ? eventServers?.find((server) => server.serverId === request.serverId)?.name
            : undefined;
        pending = client
          .createEventSource(workspaceId, { ...request, ...(name ? { name } : {}) })
          .then((created) => {
            setAdded((current) => new Map(current).set(sourceId, created.source.id));
            return created.source.id;
          });
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
