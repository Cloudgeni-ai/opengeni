/**
 * The server's readiness check of agents (SetupReadiness), and whether an
 * agent is working now, read for the Agents list and an agent's page.
 */
import { useEffect, useState } from "react";
import type { AgentChat, SetupReadiness } from "@opengeni/contracts";

import { useAppContext } from "../../app-context";
import type { AgentReadinessItem, AgentReadinessSummary } from "./agent-status";

/** How many agents' readiness and activity the list reads, at most. */
export const AGENT_LIST_READS_MAX = 30;

/** A chat updated this recently may still be running; an older one isn't asked about. */
const RECENT_MS = 15 * 60 * 1000;

const WORKING = new Set(["queued", "running", "recovering", "waiting_capacity"]);

export function agentReadinessSummary(readiness: SetupReadiness): AgentReadinessSummary {
  return {
    ready: readiness.ready,
    missingConnections: readiness.missing.map((missing) => missing.name),
    stepsLeft: readiness.missing.length,
  };
}

export function agentReadinessItems(readiness: SetupReadiness): AgentReadinessItem[] {
  return readiness.connections.map((connection) => ({
    key: connection.provider,
    label: connection.name,
    ready: connection.connected,
    required: connection.required,
    reason: connection.connected
      ? null
      : (readiness.missing.find((missing) => missing.provider === connection.provider)?.reason ??
        null),
  }));
}

/**
 * Readiness per agent, for agents added from a ready-made one (any other is
 * ready), read in one request. Absent until read, and when the server has no
 * check.
 */
export function useAgentsReadiness(
  workspaceId: string,
  agents: readonly { id: string; templateKey?: string | null | undefined }[] | undefined,
): ReadonlyMap<string, SetupReadiness> {
  const { client } = useAppContext();
  const [read, setRead] = useState<ReadonlyMap<string, SetupReadiness>>(() => new Map());
  const ids = (agents ?? [])
    .filter((agent) => agent.templateKey)
    .slice(0, AGENT_LIST_READS_MAX)
    .map((agent) => agent.id)
    .join(",");
  useEffect(() => {
    if (!ids) return;
    let live = true;
    const wanted = new Set(ids.split(","));
    if (typeof client.listAgentReadiness === "function") {
      client.listAgentReadiness(workspaceId).then(
        (entries) =>
          live &&
          setRead(
            new Map(
              entries
                .filter((entry) => wanted.has(entry.agentId))
                .map((entry) => [entry.agentId, entry.readiness] as const),
            ),
          ),
        () => undefined,
      );
    } else if (typeof client.getAgentReadiness === "function") {
      // A client without the batch read.
      for (const agentId of wanted) {
        client.getAgentReadiness(workspaceId, agentId).then(
          (readiness) => live && setRead((current) => new Map(current).set(agentId, readiness)),
          () => undefined,
        );
      }
    }
    return () => {
      live = false;
    };
  }, [client, ids, workspaceId]);
  return read;
}

export interface AgentActivity {
  /** When its newest chat was last active. */
  lastRun: string | null;
  /** Its newest chat is running now. */
  working: boolean;
}

/** Each agent's last run and whether it is working now, from its newest chat. */
export function useAgentsActivity(
  workspaceId: string,
  agentIds: readonly string[],
): ReadonlyMap<string, AgentActivity> {
  const { client } = useAppContext();
  const [activity, setActivity] = useState<ReadonlyMap<string, AgentActivity>>(() => new Map());
  const ids = agentIds.slice(0, AGENT_LIST_READS_MAX).join(",");
  useEffect(() => {
    if (!ids) return;
    let live = true;
    const set = (agentId: string, next: AgentActivity) =>
      live && setActivity((current) => new Map(current).set(agentId, next));
    for (const agentId of ids.split(",")) {
      client.listAgentChats(workspaceId, agentId, { filter: "everyone", limit: 1 }).then(
        (page) => {
          const latest: AgentChat | undefined = page.chats[0];
          if (!latest) return;
          set(agentId, { lastRun: latest.updatedAt, working: false });
          if (Date.now() - Date.parse(latest.updatedAt) > RECENT_MS) return;
          client.getSession(workspaceId, latest.sessionId).then(
            (session) =>
              WORKING.has(String((session as { status?: unknown }).status)) &&
              set(agentId, { lastRun: latest.updatedAt, working: true }),
            () => undefined,
          );
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [client, ids, workspaceId]);
  return activity;
}
