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
  | { ok: false; code: AgentErrorCode; message: string; agentIds?: string[] };

/**
 * The calling chat's privacy. The delegated chat inherits the session row's
 * visibility (`onlyMe`); `private` also covers a Slack DM, for Memory.
 */
export type DelegationCallerChat = {
  private: boolean;
  onlyMe?: boolean;
  /** A Slack DM: its saves land in workspace Knowledge, not Memory. */
  slackDm?: boolean;
  ownerSubjectId: string | null;
};

/**
 * Whose agents a delegated chat may run: the owner of an Only me calling chat
 * (its child is the same owner's Only me chat, whoever runs the turn, such as
 * an Only me automation's run), otherwise the person the grant acts for.
 */
export function delegationAgentSubject(
  grant: Pick<AccessGrant, "subjectId">,
  caller?: DelegationCallerChat | null,
): string | null {
  if (caller && (caller.onlyMe ?? caller.private) && caller.ownerSubjectId) {
    return caller.ownerSubjectId;
  }
  return grant.subjectId ?? null;
}

/**
 * The agent a delegation names, as the person the grant acts for may use it.
 * An open Slack chat acts for someone outside the workspace: only agents
 * anyone in the organization can use are reachable from it. A shared calling
 * chat makes a shared child, which can't run an Only me agent, so only shared
 * agents are considered (and an ambiguous name never lists Only me ones). An
 * Only me calling chat considers its owner's agents (see
 * delegationAgentSubject).
 */
export async function resolveDelegationAgent(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  workspaceId: string,
  ref: string,
  caller?: DelegationCallerChat | null,
): Promise<DelegationAgentOutcome> {
  const openUse = isOpenSlackAgentSubject(grant.subjectId);
  const sharedChild = caller ? !(caller.onlyMe ?? caller.private) : false;
  const outcome = await resolveWorkspaceAgentRef(
    deps.db,
    { accountId: grant.accountId, workspaceId },
    {
      ref,
      viewerSubjectId: openUse || sharedChild ? null : delegationAgentSubject(grant, caller),
      // Filtered before the ambiguity check, so an outsider never sees ids
      // of agents they can't use.
      ...(openUse ? { organizationAccessOnly: true } : {}),
    },
  );
  if (outcome.kind === "ambiguous") {
    return {
      ok: false,
      code: "agent_name_ambiguous",
      agentIds: outcome.agentIds,
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
    slackDm?: boolean;
    memoryOff?: boolean;
  },
): string | undefined {
  if (!agent.memoryEnabled) return input.instructions;
  const guidance = agentMemoryGuidance(
    agentMemoryAccess(agent, {
      private: input.private,
      ownerSubjectId: input.ownerSubjectId,
      memoryOff: input.memoryOff ?? false,
      slackDm: input.slackDm ?? false,
    }),
  );
  if (!guidance) return input.instructions;
  const own = input.instructions?.trim() ?? "";
  const combined = own ? `${own}\n\n${guidance}` : guidance;
  return combined.length <= SESSION_INSTRUCTIONS_MAX_CHARACTERS ? combined : input.instructions;
}
