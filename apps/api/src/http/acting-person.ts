import type { Permission } from "@opengeni/contracts";
import { verifiedDelegatedHumanAuthorizationForRequest } from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/* ----------------------------------------------------------------------------
   An agent acting as a person: an organization MCP action this server
   dispatched in process for someone who signed the agent in (see
   organization-mcp.ts). Routes that otherwise need the person's browser
   cookie accept it, within the connection's organization and access setting.
   The person's live role is still checked by the route, exactly as for the
   browser.

   Only Opengeni sign-in, approving a connection, third-party provider consent
   and account recovery stay in the browser; those routes don't call this.
   -------------------------------------------------------------------------- */

export type ActingPerson = { subjectId: string };

/** True when this request is an agent acting as a person. */
export function isAgentActingAsPerson(c: Context): boolean {
  return verifiedDelegatedHumanAuthorizationForRequest(c.req.raw) !== null;
}

/**
 * The person this agent acts as, for an action in `organizationId` that needs
 * `permission`; null when the request is not an agent acting as a person.
 * Another organization reads as not found; a permission the connection's
 * access setting leaves out is refused.
 */
export function agentActingAsPerson(
  c: Context,
  organizationId: string,
  permission: Permission,
): ActingPerson | null {
  const proof = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  if (!proof) return null;
  if (proof.organizationId.toLowerCase() !== organizationId.toLowerCase()) {
    throw new HTTPException(404, { message: "organization not found" });
  }
  if (!proof.permissions.includes(permission)) {
    throw new HTTPException(403, {
      message: `This connection's access doesn't include ${permission}.`,
    });
  }
  return { subjectId: proof.subjectId };
}

/**
 * The person an agent acts as, with no organization or permission check here:
 * only for a route that next requires this same person's workspace grant,
 * which carries the connection's organization, workspaces and access.
 */
export function agentActingAsPersonBeforeGrantCheck(c: Context): ActingPerson | null {
  const proof = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  return proof ? { subjectId: proof.subjectId } : null;
}

/** Organization settings: reading needs account:read, changing needs account:admin. */
export function organizationSettingsPermission(c: Context): Permission {
  return c.req.method === "GET" || c.req.method === "HEAD" ? "account:read" : "account:admin";
}

/** Refuse an agent on a browser-only step (provider consent, cross-organization actions). */
export function requireNotAgent(c: Context, what: string): void {
  if (isAgentActingAsPerson(c)) {
    throw new HTTPException(403, {
      message: `${what} has to be done by the person in the Opengeni app in a browser.`,
    });
  }
}
