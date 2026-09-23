import { verifyDelegatedAccessToken, type AccessGrant, type Permission } from "@opengeni/contracts";
import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
import {
  externalActorContinuationForAuthorization,
  requireConnectOwnerAuthority,
  hasPermission,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";

export type IntegrationCommitGrant = AccessGrant & {
  authorizeCommit: (tx: Database) => Promise<void>;
};

/** Keep server-verified provenance alongside the grant across provider work.
 * Call only inside the policy transaction, before persistence locks. */
export async function integrationCommitGrant(
  authorization: AccessGrantAuthorization,
  permissions: readonly Permission[],
  request: { settings: Settings; authorizationHeader?: string | undefined },
): Promise<IntegrationCommitGrant> {
  const grant = structuredClone(authorization.grant);
  const continuation = externalActorContinuationForAuthorization(authorization);
  const state = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    personalOwnerVerified: authorization.canonicalManagedHumanSession,
    ...(continuation ? { externalContinuation: structuredClone(continuation) } : {}),
  };
  const required = [...permissions];
  const token = request.authorizationHeader?.startsWith("Bearer ")
    ? request.authorizationHeader.slice(7)
    : null;
  const secret = resolveFirstPartyDelegationSecret(request.settings);
  const signed = token && secret ? await verifyDelegatedAccessToken(secret, token) : null;
  if (signed) {
    const matches = (value: NonNullable<typeof signed>) =>
      value.accountId === state.accountId &&
      value.workspaceId === state.workspaceId &&
      value.subjectId === state.subjectId &&
      required.every((permission) => hasPermission(value.permissions, permission));
    if (!matches(signed))
      throw new HTTPException(403, { message: "Integration bearer authority mismatch" });
    return {
      ...grant,
      authorizeCommit: async (tx) => {
        const currentSecret = resolveFirstPartyDelegationSecret(request.settings);
        const current =
          currentSecret && token ? await verifyDelegatedAccessToken(currentSecret, token) : null;
        if (!current || !matches(current))
          throw new HTTPException(403, {
            message: "Integration bearer authority expired or changed",
          });
        // A signed external continuation still has live host/key/link authority.
        if (continuation)
          for (const permission of required)
            await requireConnectOwnerAuthority(tx, state, permission);
      },
    };
  }
  return {
    ...grant,
    authorizeCommit: async (tx) => {
      for (const permission of required) await requireConnectOwnerAuthority(tx, state, permission);
    },
  };
}
