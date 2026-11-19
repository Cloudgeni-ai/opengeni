/**
 * Publish "move running chats": one chat at a time, move an organization
 * agent chat to the newly published version.
 *
 * In one transaction with the chat locked: the agent's tool servers are
 * materialized again for the new version (keeping servers the chat added or
 * replaced, re-applying the chat's recorded tool server changes and keeping
 * per-chat logins while a server's URL is unchanged), the tool policy version
 * is bumped, `agent_version` is set and the recorded changes are compared
 * again with the new version. `agent_prompt_version` is left alone: the next
 * turn delivers the newer Instructions as a history item and compaction folds
 * them into the prompt. A chat with a running turn or one waiting on a person
 * (an approval or a question) is deferred, never interrupted.
 */
import type { OrgAgentVersionConfig, Session, ToolRef } from "@opengeni/contracts";
import {
  appendSessionEventsWithLockedSessionUpdate,
  type Database,
  type OrgAgentMoveSessionMcpServerRow,
} from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import { planOrgAgentSessionMove } from "./org-agent-config";
import { toolPolicyAuditSnapshot } from "./sessions";

export type OrgAgentSessionMoveOutcome =
  /** Moved to the new version. */
  | "moved"
  /** A turn runs or waits on a person; try again later. */
  | "deferred"
  /** Already on the version, no longer this agent's chat, or gone. */
  | "skipped";

export type OrgAgentMoveVersion = {
  version: number;
  config: OrgAgentVersionConfig;
  toolCatalog: unknown;
};

/** Whether a chat must not be moved now: a turn runs or it waits on a person. */
export function orgAgentMoveDeferred(
  session: Pick<Session, "status" | "activeTurnId">,
): boolean {
  return (
    session.activeTurnId != null ||
    session.status === "running" ||
    session.status === "requires_action"
  );
}

export async function moveSessionToOrgAgentVersion(
  deps: { db: Database; bus?: EventBus | null },
  input: {
    workspaceId: string;
    sessionId: string;
    agentId: string;
    to: OrgAgentMoveVersion;
    /** The version config a chat runs now (cached by the caller), or null if unknown. */
    fromConfig: (version: number) => Promise<OrgAgentVersionConfig | null>;
    toolServers: ReadonlyMap<string, { key: string; name: string; url: string }>;
  },
): Promise<OrgAgentSessionMoveOutcome> {
  let outcome: OrgAgentSessionMoveOutcome = "skipped";
  const events = await appendSessionEventsWithLockedSessionUpdate(
    deps.db,
    input.workspaceId,
    input.sessionId,
    async (session, context) => {
      const state = context.orgAgentState;
      if (!state || state.agentId !== input.agentId || state.version === input.to.version) {
        outcome = "skipped";
        return { events: [] };
      }
      if (orgAgentMoveDeferred(session)) {
        outcome = "deferred";
        return { events: [] };
      }
      const currentServers = await context.listSessionMcpServerRows();
      const plan = planOrgAgentSessionMove<OrgAgentMoveSessionMcpServerRow>({
        currentServers,
        currentTools: session.tools,
        fromConfig: await input.fromConfig(state.version),
        toConfig: input.to.config,
        toToolCatalog: input.to.toolCatalog,
        toolServers: input.toolServers,
        overrides: state.overrides,
      });
      const upserted = new Set(plan.upsertedServerIds);
      await context.replaceSessionMcpServersForOrgAgentMove({
        removeIds: plan.removedServerIds,
        upsert: plan.servers
          .filter((server) => upserted.has(server.id))
          .map((server) => ({
            id: server.id,
            name: server.name ?? null,
            url: server.url,
            allowedTools: server.allowedTools ?? null,
            timeoutMs: server.timeoutMs ?? null,
            cacheToolsList: server.cacheToolsList ?? false,
            requireApproval: server.requireApproval ?? null,
            connectionRef: server.connectionRef ?? null,
            headersEncrypted: server.headersEncrypted ?? {},
          })),
      });
      const nextTools: ToolRef[] = plan.tools;
      const firstPartyMcpTools = [...(session.firstPartyMcpTools ?? [])];
      const currentVersion = session.toolPolicyVersion;
      const nextVersion = currentVersion + 1;
      outcome = "moved";
      return {
        events: [
          {
            type: "session.tool_policy.updated" as const,
            payload: {
              before: toolPolicyAuditSnapshot(session, session.tools, firstPartyMcpTools),
              after: toolPolicyAuditSnapshot(session, nextTools, firstPartyMcpTools),
              version: nextVersion,
              effectiveFrom: "next_attempt",
              orgAgent: {
                id: input.agentId,
                fromVersion: state.version,
                toVersion: input.to.version,
              },
            },
          },
        ],
        update: {
          tools: nextTools,
          toolPolicyVersion: nextVersion,
          expectedToolPolicyVersion: currentVersion,
          orgAgent: {
            expectedVersion: state.version,
            version: input.to.version,
            overrides: plan.overrides,
          },
        },
      };
    },
    { activity: "semantic" },
  );
  if (events.length > 0 && deps.bus) {
    await publishDurableSessionEvents(deps.bus, input.workspaceId, input.sessionId, events);
  }
  return outcome;
}
