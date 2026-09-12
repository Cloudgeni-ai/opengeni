import { createHmac } from "node:crypto";
import { RotateSessionMcpCredentialsRequest, type AccessGrant } from "@opengeni/contracts";
import {
  encryptVariableSetValue,
  getWorkspaceGrant,
  subjectHasLiveWorkspaceAuthorityInScope,
  type Database,
} from "@opengeni/db";
import {
  rotateSessionMcpCredentialsAtomically,
  SessionMcpCredentialRotationError,
} from "@opengeni/db/session-mcp-credential-rotation";
import { HTTPException } from "hono/http-exception";
import type { Settings } from "@opengeni/config";
import {
  requirePermission,
  requireResolvedAccessGrantAuthorization,
  type AccessGrantAuthorization,
} from "../access";
import {
  grantHasAgentAttemptAuthority,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type SessionAuthorizationDependencies,
} from "../session-authorization";
import { requireVariableSetEncryption } from "../domain/environments";
import { normalizedSessionMcpCredentialHeaders } from "../domain/sessions";
import { externalContinuationCommitAuthorizer } from "./external-continuation";

/** HMAC domains separate request identity from key availability. The key tag
 * carries no request material and neither fingerprint is returned publicly. */
export function sessionMcpRotationFingerprint(
  key: Uint8Array,
  scope: { accountId: string; workspaceId: string; sessionId: string; subjectId: string },
  request: RotateSessionMcpCredentialsRequest,
) {
  return {
    digestKeyTag: createHmac("sha256", key)
      .update("opengeni:session-mcp-rotation:key:v1")
      .digest("hex"),
    requestDigest: createHmac("sha256", key)
      .update("opengeni:session-mcp-rotation:request:v1\0")
      .update(JSON.stringify({ ...scope, request }))
      .digest("hex"),
  };
}

function requireRotationGrant(grant: AccessGrant) {
  if (grantHasAgentAttemptAuthority(grant))
    throw new HTTPException(403, { message: "host authorization required" });
  requirePermission(grant, "sessions:control");
  requirePermission(grant, "mcp_servers:attach");
}

/** HTTP/SDK host boundary only. The mandatory callback re-resolves request
 * authentication with the transaction handle, not a cached route-time grant. */
export async function rotateSessionMcpCredentialsForRequest(
  deps: SessionAuthorizationDependencies & { settings: Settings },
  authorization: AccessGrantAuthorization,
  sessionId: string,
  raw: unknown,
  reauthorize: (tx: Database) => Promise<AccessGrant>,
) {
  const grant = requireResolvedAccessGrantAuthorization(
    authorization,
    authorization.grant.workspaceId,
  );
  requireRotationGrant(grant);
  const parsed = RotateSessionMcpCredentialsRequest.safeParse(raw);
  if (!parsed.success)
    throw new HTTPException(422, { message: "invalid credential rotation request" });
  const encryptionKey = requireVariableSetEncryption(deps.settings);
  let request: RotateSessionMcpCredentialsRequest;
  try {
    request = {
      operationKey: parsed.data.operationKey,
      updates: parsed.data.updates
        .map((update) => ({
          id: update.id,
          expectedCredentialVersion: update.expectedCredentialVersion,
          expectedServerUrl: update.expectedServerUrl,
          headers: Object.fromEntries(
            Object.entries(normalizedSessionMcpCredentialHeaders(update.headers))
              .map(([name, value]) => [name.toLowerCase(), value] as const)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
          ),
        }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    };
    if (new Set(request.updates.map((update) => update.id)).size !== request.updates.length)
      throw new Error();
  } catch {
    // Header names and validation paths are caller-controlled secret channels.
    throw new HTTPException(422, { message: "invalid credential rotation headers or server IDs" });
  }
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    subjectId: grant.subjectId,
    actorType: grant.principalKind === "service" ? ("service" as const) : ("human" as const),
  };
  const externalAuthorize = externalContinuationCommitAuthorizer(authorization);
  try {
    return await rotateSessionMcpCredentialsAtomically(deps.db, {
      ...scope,
      operationKey: request.operationKey,
      ...sessionMcpRotationFingerprint(encryptionKey, scope, request),
      updates: request.updates.map(({ headers, ...update }) => ({
        ...update,
        headersEncrypted: Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name,
            encryptVariableSetValue(encryptionKey, value),
          ]),
        ),
      })),
      authorize: async (tx) => {
        await externalAuthorize?.(tx);
        const fresh = await reauthorize(tx);
        if (
          fresh.accountId !== grant.accountId ||
          fresh.workspaceId !== grant.workspaceId ||
          fresh.subjectId !== grant.subjectId ||
          fresh.principalKind !== grant.principalKind
        )
          throw new HTTPException(403, { message: "credential rotation authority changed" });
        requireRotationGrant(fresh);
        if (fresh.principalKind === "human_session" && !externalAuthorize) {
          // Signed host grants may narrow a named human's permissions, never
          // outlive removal or expand that human's current workspace grant.
          const live = await getWorkspaceGrant(tx, fresh.subjectId, fresh.workspaceId);
          if (live) {
            requireRotationGrant(live);
          } else if (!authorization.canonicalManagedHumanSession) {
            throw new HTTPException(403, { message: "credential rotation authority changed" });
          }
          if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, scope))) {
            throw new HTTPException(403, { message: "credential rotation authority changed" });
          }
        }
        await requireSessionAuthorization({ ...deps, db: tx }, fresh, {
          sessionId,
          operation: "session.mcp.credentials.rotate",
          surface: "http",
        });
      },
    });
  } catch (error) {
    if (error instanceof HTTPException)
      throw new HTTPException(error.status, { message: "credential rotation access denied" });
    if (error instanceof SessionAuthorizationDeniedError)
      throw new HTTPException(403, { message: "credential rotation access denied" });
    if (error instanceof SessionAuthorizationUnavailableError)
      throw new HTTPException(503, { message: "credential rotation authorization unavailable" });
    if (error instanceof SessionMcpCredentialRotationError) {
      const status =
        error.code === "receipt_key_unavailable"
          ? 503
          : error.code === "authority_revoked"
            ? 403
            : error.code === "not_found"
              ? 404
              : error.code === "invalid_request" || error.code === "brokered_server"
                ? 422
                : 409;
      throw new HTTPException(status, { message: `credential_rotation_${error.code}` });
    }
    // Drizzle failures can include query parameters. Never attach their cause,
    // ciphertext, fingerprints, header names, or raw input to API telemetry.
    throw new HTTPException(503, { message: "credential rotation unavailable" });
  }
}
