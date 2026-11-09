/**
 * The agent a chat was started with, for the chat header: its id from
 * `session.agentId`, then its current name and icon read once and shared by
 * every header that shows it.
 *
 * No zod here: the chat header is an eager module.
 */
import type { Session } from "../types";
import { useOptionalAppContext } from "../app-context";
import {
  sessionSlackAgentInfo,
  useSessionAgentInfo,
  type SessionAgentInfo,
  type SessionAgentRef,
} from "../../session-avatar-model";

export {
  forgetSessionAgent,
  sessionAgentRef,
  type SessionAgentInfo,
  type SessionAgentRef,
} from "../../session-avatar-model";

/** True for an agent chat someone started in Slack. */
export function sessionStartedInSlack(
  session: Pick<Session, "metadata"> & { agentId?: string | null | undefined },
): boolean {
  const slack = sessionSlackAgentInfo(session.metadata);
  return slack !== null && slack.id === session.agentId;
}

/**
 * Where and by whom the chat started, for the line under its title:
 * "Started in Slack by Kari". Null for chats started in the app.
 */
export function sessionAgentSourceLine(
  session: Pick<Session, "metadata" | "createdBy"> & { agentId?: string | null | undefined },
): string | null {
  if (!sessionStartedInSlack(session)) return null;
  const by =
    session.createdBy?.kind === "subject" && session.createdBy.label?.trim()
      ? session.createdBy.label.trim()
      : null;
  return by ? `Started in Slack by ${by}` : "Started in Slack";
}

/** The agent's current name and icon; the chat's own record until (or unless) it loads. */
export function useSessionAgent(
  workspaceId: string,
  ref: SessionAgentRef | null,
): SessionAgentInfo | null {
  const context = useOptionalAppContext();
  // Read the client only for a chat with an agent.
  return useSessionAgentInfo(workspaceId, ref, () => context?.client);
}
