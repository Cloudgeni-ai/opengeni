import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { UpdateExternalIdentityMembershipRequest } from "@opengeni/contracts/external-identities";
import { updateOrganizationMember } from "@opengeni/db";
import {
  accountScopedApiKeyWorkspaceAuthority,
  requireAccessContext,
  type AccessDeps,
} from "../access";

/** Host service administration is separate from asUser and native-cookie
 * administration. The database rechecks the live key and exact external target
 * under the canonical organization lifecycle fences, including receipt replay. */
export async function updateExternalIdentityMembershipForRequest(
  context: Context,
  deps: AccessDeps,
  organizationId: string,
  membershipId: string,
  input: unknown,
) {
  const access = await requireAccessContext(context, deps);
  const service = accountScopedApiKeyWorkspaceAuthority(access);
  // The workspace projection deliberately excludes account:admin. Its opaque
  // proof establishes service provenance; the exact account grant supplies
  // this account-level permission, independently rechecked by the database.
  const account = access.accountGrants.find(
    (grant) => grant.accountId === organizationId && grant.subjectId === access.subjectId,
  );
  if (
    !service ||
    service.accountId !== organizationId ||
    !account?.permissions.includes("account:admin")
  ) {
    throw new HTTPException(403, {
      message: "external identity administration requires an organization service key",
    });
  }
  const parsed = UpdateExternalIdentityMembershipRequest.safeParse(input);
  if (!parsed.success)
    throw new HTTPException(422, { message: "invalid external identity transition" });
  return updateOrganizationMember(deps.db, {
    organizationId,
    membershipId,
    actorSubjectId: access.subjectId,
    operationId: parsed.data.operationId,
    transition: parsed.data,
  });
}
