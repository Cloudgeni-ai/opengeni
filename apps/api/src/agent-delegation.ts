import {
  SESSION_INSTRUCTIONS_MAX_CHARACTERS,
  type AccessGrant,
  type AgentErrorCode,
} from "@opengeni/contracts";
import { agentMemoryAccess, agentMemoryGuidance, type ApiRouteDeps } from "@opengeni/core";
import { resolveWorkspaceAgentRef, type AgentRecord } from "@opengeni/db";
import * as z4 from "zod/v4";

import { isOpenSlackAgentSubject } from "./integrations/slack-open-agents";

/**
 * Delegation by name: one chat starts a chat with another agent of the same
 * workspace (`session_create`'s `agentName`; an outside agent's `delegate`
 * tool takes the same parameter). The new chat runs with that agent's
 * Instructions, Memory and Can use, and its result returns to the caller like
 * any worker's. Who can use the agent is checked for the person the calling
 * chat acts for, never the calling agent.
 */
export const AGENT_REF_DESCRIPTION =
  'Name or id of an agent in this workspace to hand the work to (for example "Bug fixer"). The new chat runs as that agent, with its Instructions, Memory and Can use, and its final answer returns to you like any worker\'s. Omit for an ordinary worker.';

/** The reusable tool parameter: an agent's name or id. */
export function agentRefToolInput() {
  return z4.string().trim().min(1).max(200).describe(AGENT_REF_DESCRIPTION);
}

export type DelegationAgentOutcome =
  | { ok: true; agent: AgentRecord }
  | { ok: false; code: AgentErrorCode; message: string };

/** The calling chat's privacy, which the delegated chat inherits. */
export type DelegationCallerChat = { private: boolean; ownerSubjectId: string | null };

/**
 * The agent a delegation names, as the person the grant acts for may use it.
 * An open Slack chat acts for someone outside the workspace: only agents
 * anyone in the organization can use are reachable from it. A shared calling
 * chat makes a shared child, which can't run an Only me agent, so only shared
 * agents are considered (and an ambiguous name never lists Only me ones).
 */
export async function resolveDelegationAgent(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  workspaceId: string,
  ref: string,
  caller?: DelegationCallerChat | null,
): Promise<DelegationAgentOutcome> {
  const openUse = isOpenSlackAgentSubject(grant.subjectId);
  const sharedChild = caller ? !caller.private : false;
  const outcome = await resolveWorkspaceAgentRef(
    deps.db,
    { accountId: grant.accountId, workspaceId },
    { ref, viewerSubjectId: openUse || sharedChild ? null : (grant.subjectId ?? null) },
  );
  if (outcome.kind === "ambiguous") {
    return {
      ok: false,
      code: "agent_name_ambiguous",
      message: `More than one agent is named "${ref.trim()}". Use one of these ids: ${outcome.agentIds.join(", ")}.`,
    };
  }
  if (outcome.kind === "not_found" || (openUse && !outcome.agent.organizationAccess)) {
    return {
      ok: false,
      code: "agent_not_found",
      message: `No agent named "${ref.trim()}" is available here to the person this chat acts for. List the workspace's agents, or do the work yourself.`,
    };
  }
  return { ok: true, agent: outcome.agent };
}

/**
 * The delegated chat's Memory guidance, joined to its own instructions, the
 * way an app chat with the agent gets it. Unchanged when Memory is off or
 * there is no room: the knowledge tools still enforce the rules.
 */
export function delegatedChatInstructions(
  agent: AgentRecord,
  input: {
    instructions: string | undefined;
    ownerSubjectId: string | null;
    private: boolean;
    memoryOff?: boolean;
  },
): string | undefined {
  if (!agent.memoryEnabled) return input.instructions;
  const guidance = agentMemoryGuidance(
    agentMemoryAccess(agent, {
      private: input.private,
      ownerSubjectId: input.ownerSubjectId,
      memoryOff: input.memoryOff ?? false,
    }),
  );
  if (!guidance) return input.instructions;
  const own = input.instructions?.trim() ?? "";
  const combined = own ? `${own}\n\n${guidance}` : guidance;
  return combined.length <= SESSION_INSTRUCTIONS_MAX_CHARACTERS ? combined : input.instructions;
}
