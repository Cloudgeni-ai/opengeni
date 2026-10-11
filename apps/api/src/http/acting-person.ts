import { organizationAccessPresetPermissions, type Permission } from "@opengeni/contracts";
import { verifiedDelegatedHumanAuthorizationForRequest } from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/* ----------------------------------------------------------------------------
   An agent acting as a person: an organization MCP action this server
   dispatched in process for someone who signed the agent in, or who gave a
   session admin access (see organization-mcp.ts). Routes that otherwise need
   the person's browser cookie accept it, within the organization and the
   access the person gave it. The person's live role is still checked by the
   route, exactly as for the browser.

   With the person's full access, the agent can do what the person can in that
   organization, including approving agent sign-ins, managing connected agents
   and giving sessions admin access. An agent with less can't do those, so it
   can never widen its own access. Only Opengeni sign-in itself, sign-in
   methods and recovery, and provider sign-in pages (Claude, integration
   OAuth) stay in the browser. Device-code sign-in (Codex, SuperGrok) is
   allowed: the agent relays the code and the person approves at the provider.
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

const FULL_ACCESS = organizationAccessPresetPermissions("full");

/**
 * True when this request is an agent with the person's full access: every
 * permission, in every workspace. Session admin access always is; a connected
 * agent is when the person chose full access for it.
 */
export function isAgentWithFullAccess(c: Context): boolean {
  const proof = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  return (
    proof !== null &&
    proof.workspaceScope.kind === "all" &&
    FULL_ACCESS.every((permission) => proof.permissions.includes(permission))
  );
}

/**
 * Refuse an agent with less than the person's full access on a step that
 * gives or approves access (agent sign-ins, connected agents, admin access),
 * so it can never widen its own. The person and a full-access agent pass.
 */
export function requireFullAccessIfAgent(c: Context, what: string): void {
  if (isAgentActingAsPerson(c) && !isAgentWithFullAccess(c)) {
    throw new HTTPException(403, {
      message: `${what} needs full access, and this agent's access is limited. The person can do it in the Opengeni app.`,
    });
  }
}

/** Organization settings: reading needs account:read, changing needs account:admin. */
export function organizationSettingsPermission(c: Context): Permission {
  return c.req.method === "GET" || c.req.method === "HEAD" ? "account:read" : "account:admin";
}

/** Refuse an agent on a step that only works in a browser: signing in at a provider's own page. */
export function requireNotAgent(c: Context, what: string): void {
  if (isAgentActingAsPerson(c)) {
    throw new HTTPException(403, {
      message: `${what} has to be done by the person in the Opengeni app in a browser.`,
    });
  }
}
