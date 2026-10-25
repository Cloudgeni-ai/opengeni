import type { Permission } from "@opengeni/contracts";
import { CORE_INTEGRATION_DEFINITIONS } from "@opengeni/capabilities";
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
 * Deployment-reviewed integration definitions (Outlook Mail, OneDrive, ...).
 * Each personal account gets its own instance of the reviewed tools, which
 * resolves credentials for that person alone, so connecting one's own
 * account to one is personal setup too. The install step separately allows
 * only a fresh instance or one already bound to that same account.
 */
const REVIEWED_INTEGRATION_DEFINITION_IDS: ReadonlySet<string> = new Set(
  CORE_INTEGRATION_DEFINITIONS.map((definition) => definition.id),
);

/**
 * The permission a Connect step needs. Signing in to one's own account
 * (personal ownership and no MCP setup, with a sign-in-only provider and no
 * installation target, or a reviewed integration definition and no custom
 * source) needs only `connections:personal`; everything else keeps
 * `connections:write`. `connections:write` includes `connections:personal`.
 */
export function connectSetupPermission(attempt: {
  providerId: string;
  ownership: string;
  mcpSetup?: unknown;
  installationTarget?: unknown;
  source?: unknown;
}): "connections:personal" | "connections:write" {
  if (attempt.ownership !== "personal" || attempt.mcpSetup) return "connections:write";
  return (PERSONAL_SIGN_IN_PROVIDERS.has(attempt.providerId) && !attempt.installationTarget) ||
    (REVIEWED_INTEGRATION_DEFINITION_IDS.has(attempt.providerId) && !attempt.source)
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
