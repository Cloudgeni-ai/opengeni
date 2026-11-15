import { namedSubjectIsActiveOrganizationMember, type Database } from "@opengeni/db";

/**
 * Agents anyone in the organization can use ("Who can use it: Anyone in
 * <organization>"), the part every chat integration shares (Slack today;
 * Teams calls the same checks). Members of the agent's own workspace use it as
 * themselves, as always. Anyone else may use it only when, on every message:
 *
 * - the integration positively says they are a full member of the connected
 *   team or tenant (never a guest, an external user, a bot or a deleted user),
 *   in a conversation only that team can see; that half is the integration's
 *   own (Slack: `openSlackAgentRefusal`);
 * - their account there is linked to an Opengeni person; and
 * - that person is an active, full member of the agent's organization, read
 *   live (`organizationAgentAskerPerson`).
 *
 * Their chat runs as the agent's own read-only service principal in its
 * workspace (see slack-open-agents.ts), and they are told once that the
 * workspace's members can see what they say.
 */

/** Whether anyone in the organization may use this agent, beyond its workspace. */
export function agentOpenToOrganization(agent: {
  visibility: string;
  organizationAccess: boolean;
}): boolean {
  return agent.visibility === "workspace" && agent.organizationAccess;
}

/** Why a person the integration lets through can't use an organization agent, or null. */
export type OrganizationAgentPersonRefusal = "not_linked" | "not_organization_member";

/**
 * The Opengeni half of who may use an organization agent: the integration
 * account is linked to someone who is an active, full member of the
 * agent's organization (both read live by the caller on every message).
 */
export function organizationAgentPersonRefusal(input: {
  linkedSubjectId: string | null;
  organizationMember: boolean;
}): OrganizationAgentPersonRefusal | null {
  if (!input.linkedSubjectId) return "not_linked";
  if (!input.organizationMember) return "not_organization_member";
  return null;
}

/**
 * The Opengeni person behind a message to an organization agent, or why
 * there is none. `connectionAccountId` is the organization the integration
 * is connected to; the agent must belong to it, and a mismatch fails closed.
 * Membership is read live, never cached.
 */
export async function organizationAgentAskerPerson(
  db: Database,
  input: {
    connectionAccountId: string;
    agentAccountId: string;
    linkedSubjectId: string | null;
  },
): Promise<{ subjectId: string } | { refusal: OrganizationAgentPersonRefusal }> {
  const { linkedSubjectId } = input;
  const organizationMember =
    linkedSubjectId !== null &&
    input.agentAccountId === input.connectionAccountId &&
    (await namedSubjectIsActiveOrganizationMember(db, {
      accountId: input.connectionAccountId,
      subjectId: linkedSubjectId,
    }));
  const refusal = organizationAgentPersonRefusal({ linkedSubjectId, organizationMember });
  if (refusal || linkedSubjectId === null) return { refusal: refusal ?? "not_linked" };
  return { subjectId: linkedSubjectId };
}
