import type { AccessContext } from "@opengeni/contracts";
import { listOrganizationMembers } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";

/**
 * Who an organization administrator may act on beyond themselves. Owners and
 * admins revoke and disconnect what other people hold, except the owner's:
 * only an owner acts on an owner's keys and connected agents, so an admin can
 * never cut the owner off.
 *
 * Read only for an administrator acting on someone else; the membership list
 * is itself owner-or-admin only. If it can't be read, nobody else's are
 * manageable: refusing is the safe answer.
 */
export async function othersAnAdministratorMayManage(
  deps: ApiRouteDeps,
  context: AccessContext,
  organizationId: string,
): Promise<(subjectId: string) => boolean> {
  let members;
  try {
    members = await listOrganizationMembers(deps.db, {
      organizationId,
      actorSubjectId: context.subjectId,
    });
  } catch {
    return () => false;
  }
  const owners = new Set(
    members.filter((member) => member.role === "owner").map((member) => member.subjectId),
  );
  if (owners.has(context.subjectId)) return () => true;
  return (subjectId) => !owners.has(subjectId);
}
