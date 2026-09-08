import { HTTPException } from "hono/http-exception";
import { resolveHostMcpBindingOwner, type Database } from "@opengeni/db";
import {
  externalActorContinuationForAuthorization,
  hasPermission,
  hasVerifiedOwningUserAuthorization,
  requireResolvedAccessGrantAuthorization,
  type AccessGrantAuthorization,
} from "../access";
import { requireConnectOwnerAuthority } from "./connect-authority";

/** Direct user admission only. Agents inherit exact accepted snapshots instead.
 * Native and externally represented users share owner semantics; service keys
 * cannot impersonate a human owner merely by naming a subject. */
export function prepareHostMcpOwnerAuthorization(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  permission: "connections:read" | "connections:write",
) {
  const grant = requireResolvedAccessGrantAuthorization(authorization, workspaceId);
  if (
    !hasVerifiedOwningUserAuthorization(authorization) ||
    grant.metadata?.sessionId ||
    !hasPermission(grant.permissions, permission)
  )
    throw new HTTPException(403, {
      message: "Host binding requires verified owning-user authority",
    });
  const continuation = externalActorContinuationForAuthorization(authorization);
  const scope = {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    personalOwnerVerified: authorization.canonicalManagedHumanSession,
    ...(continuation ? { externalContinuation: continuation } : {}),
  };
  return async (tx: Database) => {
    await requireConnectOwnerAuthority(tx, scope, permission);
    return resolveHostMcpBindingOwner(tx, scope);
  };
}
