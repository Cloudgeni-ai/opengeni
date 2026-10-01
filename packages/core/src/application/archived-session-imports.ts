import {
  AppendArchivedSessionEventsRequest,
  AppendArchivedSessionEventsResponse,
  ImportArchivedSessionRequest,
  ImportArchivedSessionResponse,
  type Permission,
  type SessionEvent,
} from "@opengeni/contracts";
import {
  ArchivedSessionImportError,
  appendArchivedSessionEvents,
  getArchivedSessionImportId,
  importArchivedSession,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import {
  hasVerifiedOwningUserAuthorization,
  requirePermission,
  requireResolvedAccessGrantAuthorization,
  type AccessGrantAuthorization,
} from "../access";
import type { ApiRouteDeps } from "../dependencies";
import { creationInitiatorForGrant } from "../domain/sessions";
import { fileOwnerContextForAccess } from "../domain/file-owner";
import {
  grantHasAgentAttemptAuthority,
  requireSessionAuthorization,
} from "../session-authorization";
import { externalContinuationCommitAuthorizer } from "./external-continuation";
import { requireManagedHumanPrivateSessionCreate } from "./session-tenancy";

export { ArchivedSessionImportError } from "@opengeni/db";

function requireImportAuthorization(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  permission: Permission,
) {
  const grant = requireResolvedAccessGrantAuthorization(authorization, workspaceId);
  requirePermission(grant, permission);
  if (grantHasAgentAttemptAuthority(grant)) {
    throw new HTTPException(403, {
      message: "Session history imports require a user or service request",
    });
  }
  return grant;
}

function importerScope(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  permission: Permission,
  fileOwnerSubjectId: string | null,
) {
  const grant = authorization.grant;
  const apiKeyId =
    grant.principalKind === "api_key" && grant.subjectId.startsWith("api_key:")
      ? grant.subjectId.slice("api_key:".length)
      : undefined;
  const beforeCommit = externalContinuationCommitAuthorizer(authorization);
  return {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    fileOwnerSubjectId,
    requiredPermission: permission,
    requireLiveSubject:
      hasVerifiedOwningUserAuthorization(authorization) || authorization.canonicalLocalHumanSession,
    ...(apiKeyId ? { apiKeyId } : {}),
    ...(beforeCommit ? { beforeCommit } : {}),
  };
}

/** Committed import truth survives unavailable fanout; SSE catch-up repairs it.
 * Never make a known committed append look failed and invite an unsafe retry. */
async function publishImportedEvents(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
  events: SessionEvent[],
): Promise<void> {
  if (!events.length) return;
  try {
    await publishDurableSessionEvents(deps.bus, workspaceId, sessionId, events);
  } catch {
    console.warn("[session-import] committed timeline fanout deferred to replay", { sessionId });
  }
}

export async function importArchivedSessionForRequest(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  rawPayload: unknown,
): Promise<ImportArchivedSessionResponse> {
  const grant = requireImportAuthorization(authorization, workspaceId, "sessions:create");
  const payload = ImportArchivedSessionRequest.parse(rawPayload);
  if (payload.visibility === "user_private") {
    await requireManagedHumanPrivateSessionCreate(deps, authorization, workspaceId);
  }
  const creator = creationInitiatorForGrant(grant);
  if (!creator.initiator)
    throw new HTTPException(403, { message: "Import creator is unavailable" });
  const actor = await fileOwnerContextForAccess(deps, authorization, "sessions:create");
  const result = await withSessionRlsActorContext(actor, () =>
    importArchivedSession(deps.db, {
      ...importerScope(
        authorization,
        workspaceId,
        "sessions:create",
        actor.privateFileOwnerSubjectId ?? null,
      ),
      payload,
      createdBy: creator.initiator!,
      createdByContext: creator.context ?? {},
    }),
  );
  await publishImportedEvents(deps, workspaceId, result.session.id, result.events);
  return ImportArchivedSessionResponse.parse(result);
}

export async function appendArchivedSessionEventsForRequest(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  importId: string,
  rawPayload: unknown,
): Promise<AppendArchivedSessionEventsResponse> {
  const grant = requireImportAuthorization(authorization, workspaceId, "sessions:control");
  const payload = AppendArchivedSessionEventsRequest.parse(rawPayload);
  const actor = await fileOwnerContextForAccess(deps, authorization, "sessions:control");
  const result = await withSessionRlsActorContext(actor, async () => {
    const sessionId = await getArchivedSessionImportId(
      deps.db,
      workspaceId,
      grant.subjectId,
      importId,
    );
    if (!sessionId) throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
    await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.append",
      surface: "core",
    });
    return appendArchivedSessionEvents(deps.db, {
      ...importerScope(
        authorization,
        workspaceId,
        "sessions:control",
        actor.privateFileOwnerSubjectId ?? null,
      ),
      importId,
      sessionId,
      payload,
    });
  });
  await publishImportedEvents(deps, workspaceId, result.sessionId, result.events);
  return AppendArchivedSessionEventsResponse.parse(result);
}
