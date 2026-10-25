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
  lockConnectionSetupKeyAuthority,
  nestedPostgresSqlState,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/** Connect providers whose personal setup is only a sign-in: no installation. */
const PERSONAL_SIGN_IN_PROVIDERS = new Set([
  "mcp-oauth",
  "gmail",
  "google-drive",
  "slack-personal",
]);

/**
 * The permission a Connect step needs. Signing in to one's own account
 * (personal ownership, a sign-in-only provider, no MCP setup or installation
 * target) needs only `connections:personal`; everything else keeps
 * `connections:write`. `connections:write` includes `connections:personal`.
 */
export function connectSetupPermission(attempt: {
  providerId: string;
  ownership: string;
  mcpSetup?: unknown;
  installationTarget?: unknown;
}): "connections:personal" | "connections:write" {
  return attempt.ownership === "personal" &&
    PERSONAL_SIGN_IN_PROVIDERS.has(attempt.providerId) &&
    !attempt.mcpSetup &&
    !attempt.installationTarget
    ? "connections:personal"
    : "connections:write";
}

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
    const authority = await lockConnectionSetupKeyAuthority(db, state);
    if (!authority || !hasPermission(authority.permissions, permission, authority.permissionMode))
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
