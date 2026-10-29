import type { AccessGrant } from "@opengeni/contracts";
import {
  PERSONAL_API_KEY_TOKEN_PREFIX,
  verifiedDelegatedHumanAuthorizationForRequest,
} from "@opengeni/core";
import type { DisconnectAuditActor } from "@opengeni/db";
import type { Context } from "hono";

/* ----------------------------------------------------------------------------
   Who disconnected a subscription or connector, for its audit record.

   The source is the surface the request came through, taken only from
   authenticated provenance, never from headers or body fields a caller picks:
   - "app": a person signed in to the app (a human session);
   - "api": an API, organization, personal or configured key, or a service
     principal;
   - "agent": an agent, either an agent attempt's own credential (with its
     session, turn and attempt) or an agent acting as a person through
     organization actions (a session with admin access, or a connected agent).
   -------------------------------------------------------------------------- */

/** How an in-process organization action acts for a person (see organization-mcp.ts). */
export type ActionAuditProvenance = Omit<DisconnectAuditActor, "subjectId">;

const actionProvenance = new WeakMap<Request, ActionAuditProvenance>();

/**
 * TRUSTED IN-PROCESS DISPATCH ONLY: record who acts through this exact raw
 * Request (an organization action run for a person, or a published Site's
 * verified viewer). Never call it with caller-supplied input.
 */
export function stampActionAuditProvenance(
  request: Request,
  provenance: ActionAuditProvenance,
): void {
  actionProvenance.set(request, Object.freeze({ ...provenance }));
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function grantProvenance(grant: AccessGrant): ActionAuditProvenance {
  const principalKind = grant.principalKind ?? null;
  if (principalKind === "agent_attempt") {
    return {
      source: "agent",
      principalKind,
      sessionId: stringClaim(grant.metadata?.sessionId),
      turnId: stringClaim(grant.metadata?.turnId),
      attemptId: stringClaim(grant.metadata?.attemptId),
    };
  }
  // An organization key acting as one of its product's people is still a key.
  if (principalKind === "human_session" && grant.metadata?.externalActor === undefined) {
    return {
      source: "app",
      principalKind,
      ...(grant.metadata?.delegated === true ? { via: "delegated_token" } : {}),
    };
  }
  return {
    source: "api",
    principalKind,
    ...(grant.metadata?.externalActor !== undefined ? { via: "external_actor" } : {}),
  };
}

/**
 * The audit actor of this request. `grant` is the route's resolved workspace
 * grant; organization routes that authenticated a person without one pass
 * none (a managed browser session, or the local install's own person).
 */
export function disconnectAuditActor(
  c: Context,
  input: { subjectId: string; grant?: AccessGrant | null },
): DisconnectAuditActor {
  const request = c.req.raw;
  const stamped = actionProvenance.get(request);
  if (stamped) return { subjectId: input.subjectId, ...stamped };
  // A verified person proof without an action stamp: a personal API key, or
  // an in-process dispatch for a person that stamped nothing more specific.
  if (verifiedDelegatedHumanAuthorizationForRequest(request)) {
    const authorization = request.headers.get("authorization") ?? "";
    return authorization.startsWith(`Bearer ${PERSONAL_API_KEY_TOKEN_PREFIX}`)
      ? { subjectId: input.subjectId, source: "api", principalKind: "personal_api_key" }
      : { subjectId: input.subjectId, source: "agent", principalKind: "delegated_person" };
  }
  if (input.grant) return { subjectId: input.subjectId, ...grantProvenance(input.grant) };
  return { subjectId: input.subjectId, source: "app", principalKind: "human_session" };
}
