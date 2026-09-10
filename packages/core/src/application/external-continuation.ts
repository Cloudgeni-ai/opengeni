import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import type { Permission } from "@opengeni/contracts";
import {
  ensureExternalIdentity,
  resolveExternalIdentityLink,
  getWorkspaceGrant,
  lockActiveExternalOrganizationKey,
  lockExternalWorkspaceMembershipLifecycle,
  managedPersonalWorkspacePermissions,
  nestedPostgresSqlState,
  withWorkspaceSubjectRls,
  type Database,
} from "@opengeni/db";
import {
  hasPermission,
  externalActorContinuationForAuthorization,
  type AccessGrantAuthorization,
} from "../access";
import { HTTPException } from "hono/http-exception";

/** Capture verified request authority before asynchronous preflight. Invoke
 * inside the canonical mutation transaction after its lifecycle locks, so a
 * revoked key/generation rolls the write back without changing lock order. */
export function externalContinuationCommitAuthorizer(
  authorization: AccessGrantAuthorization | undefined,
): ((tx: Database) => Promise<void>) | undefined {
  const continuation = authorization
    ? externalActorContinuationForAuthorization(authorization)
    : null;
  if (!continuation || !authorization) return undefined;
  const scope = {
    accountId: authorization.grant.accountId,
    workspaceId: authorization.grant.workspaceId,
    subjectId: authorization.grant.subjectId,
  };
  const permissions = [...authorization.grant.permissions];
  return async (tx) => {
    try {
      await requireExternalContinuationAuthority(tx, continuation, scope, permissions);
    } catch (error) {
      const denied =
        nestedPostgresSqlState(error) === "42501" ||
        (error instanceof Error && error.message === "External continuation authority unavailable");
      throw new HTTPException(denied ? 403 : 503, {
        message: denied ? "external authority changed" : "external authority is unavailable",
        cause: error,
      });
    }
  };
}

/** Caller verifies/decrypts its server-minted continuation before invoking.
 * An open transaction retains lifecycle/key/identity locks through persistence.
 * Historical creator audit alone must never enter this path as a credential. */
export async function requireExternalContinuationAuthority(
  tx: Database,
  raw: unknown,
  scope: { accountId: string; workspaceId: string; subjectId: string },
  permission: Permission | readonly Permission[],
): Promise<void> {
  const { actor, identity: reference } = ExternalActorContinuation.parse(raw);
  const required = typeof permission === "string" ? [permission] : [...permission];
  const deny = () => {
    throw new Error("External continuation authority unavailable");
  };
  if (actor.accountId !== scope.accountId || actor.effectiveSubjectId !== scope.subjectId) deny();
  await lockExternalWorkspaceMembershipLifecycle(tx, scope.accountId);
  const permissions = await lockActiveExternalOrganizationKey(
    tx,
    scope.accountId,
    actor.authenticatingApiKeyId,
  );
  if (!permissions || required.some((value) => !hasPermission(permissions, value))) deny();
  const identity = await ensureExternalIdentity(tx, { accountId: scope.accountId, ...reference });
  if (
    identity.id !== actor.externalIdentityId ||
    identity.subjectId !== actor.externalSubjectId ||
    identity.authorizationRevision !== actor.externalAuthorizationRevision
  )
    deny();
  const linked =
    actor.actingMode === "linked_native"
      ? await resolveExternalIdentityLink(tx, {
          identity,
          linkId: actor.linkId!,
          expectedRevision: actor.linkRevision!,
        })
      : null;
  if (
    actor.actingMode === "linked_native" &&
    (!linked ||
      linked.link.nativeSubjectId !== scope.subjectId ||
      required.some((value) => !hasPermission(linked.link.permissions, value)))
  )
    deny();
  if (actor.actingMode === "external" && scope.subjectId !== identity.subjectId) deny();
  const grant =
    scope.workspaceId === (linked?.personalWorkspaceId ?? identity.personalWorkspaceId)
      ? {
          accountId: identity.accountId,
          permissions: managedPersonalWorkspacePermissions,
        }
      : await withWorkspaceSubjectRls(tx, scope.workspaceId, scope.subjectId, (db) =>
          getWorkspaceGrant(db, scope.subjectId, scope.workspaceId),
        );
  if (
    !grant ||
    grant.accountId !== scope.accountId ||
    required.some((value) => !hasPermission(grant.permissions, value))
  )
    deny();
}
