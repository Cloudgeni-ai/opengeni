import type { Permission } from "@opengeni/contracts";
import type { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import { hasPermission } from "../access";
import { requireExternalContinuationAuthority } from "./external-continuation";
import {
  getWorkspaceGrant,
  resolveNamedManagedPersonalWorkspaceGrant,
  lockExternalWorkspaceMembershipLifecycle,
  withWorkspaceSubjectRls,
  type Database,
  lockConnectionSetupKey,
  nestedPostgresSqlState,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/** Accept only a verified request owner or authenticated server-minted OAuth
 * state. The callback does not need a browser cookie: it rechecks the stored
 * principal against current authority before claiming and committing effects. */
export async function requireConnectOwnerAuthority(
  db: Database,
  state: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    personalOwnerVerified?: boolean;
    externalContinuation?: ExternalActorContinuation;
  },
  permission: Permission = "connections:write",
  origin: ExternalActorContinuation | null = null,
): Promise<void> {
  async function requireExternal(continuation: ExternalActorContinuation) {
    try {
      await requireExternalContinuationAuthority(db, continuation, state, permission);
    } catch (error) {
      const denied =
        nestedPostgresSqlState(error) === "42501" ||
        (error instanceof Error && error.message === "External continuation authority unavailable");
      throw new HTTPException(denied ? 403 : 503, {
        message: denied
          ? "Connection origin authority changed"
          : "Connection origin authority unavailable",
        cause: error,
      });
    }
  }
  // Current request authority cannot replace the original restriction. Native
  // owners may resume their work, but an expired host/link origin still denies.
  if (origin) await requireExternal(origin);
  if (state.externalContinuation) {
    await requireExternal(state.externalContinuation);
    return;
  }
  if (state.subjectId.startsWith("external_user:"))
    throw new HTTPException(403, { message: "External Connect continuation required" });
  if (state.subjectId.startsWith("api_key:")) {
    const permissions = await lockConnectionSetupKey(db, state);
    if (!permissions || !hasPermission(permissions, permission))
      throw new HTTPException(403, { message: "Connection API key authority changed" });
    return;
  }
  await withWorkspaceSubjectRls(db, state.workspaceId, state.subjectId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, state.accountId);
    const membership = await getWorkspaceGrant(tx, state.subjectId, state.workspaceId);
    const grant =
      membership?.accountId === state.accountId
        ? membership
        : state.personalOwnerVerified
          ? await resolveNamedManagedPersonalWorkspaceGrant(tx, state)
          : null;
    if (
      !grant ||
      grant.accountId !== state.accountId ||
      !hasPermission(grant.permissions, permission)
    )
      throw new HTTPException(403, { message: "Connection owner authority changed" });
  });
}
