/**
 * Console roles (docs/opengeni-console.md, "Roles").
 *
 * Who may use an organization's Console, decided here for every Console
 * route and for people calling the organization agent routes:
 *
 * - `full`: the organization's owners and admins (organization
 *   administration, `holdsOrganizationAdministration`). Always, from their
 *   organization role.
 * - `editor` / `viewer`: a member (organization role `member`) signed in as
 *   themselves whose Console role an owner or admin set
 *   (`organization_console_roles`). Everyone else in the organization has
 *   `none`, the default.
 * - API keys, a product's end users, services, and agents or personal keys
 *   acting for a member never get a Console role. (API keys keep their own
 *   permissions on the organization agent routes.)
 *
 * Deny by default: a route names the least access it needs and every lower
 * level is refused with 403 `console_role_required`. A Console role never
 * grants access to app workspaces, and app workspace roles never grant
 * Console access.
 */
import {
  ConsoleAccessResponse,
  ConsoleMemberRolesResponse,
  SetConsoleMemberRoleRequest,
  type AccessContext,
  type ConsoleAccessLevel,
  type ConsoleMemberRole,
} from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  holdsOrganizationAdministration,
  holdsOrganizationMemberConsoleStanding,
  requireAccessContext,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  clearConsoleMemberRole,
  ConsoleRoleTargetNotFoundError,
  findOrgAgentTestWorkspace,
  getConsoleMemberRole,
  listConsoleMemberRoles,
  listOrganizationAdministrationMembers,
  removeWorkspaceMember,
  setConsoleMemberRole,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";

/** The Console access a route needs, lowest first. */
export type ConsoleAccess = "viewer" | "editor" | "full";

const RANK: Record<ConsoleAccessLevel, number> = { none: 0, viewer: 1, editor: 2, full: 3 };

export function consoleAccessCovers(access: ConsoleAccessLevel, needed: ConsoleAccess): boolean {
  return RANK[access] >= RANK[needed];
}

/** Error `details.code` of every Console role refusal. */
export const CONSOLE_ROLE_REQUIRED = "console_role_required";

export const CONSOLE_PEOPLE_ONLY_MESSAGE =
  "Opengeni Console is for organization owners, admins and members with a Console role";

function refusal(message: string): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message,
    retryable: false,
    details: { code: CONSOLE_ROLE_REQUIRED },
  });
}

function neededMessage(needed: ConsoleAccess): string {
  if (needed === "full") return "Only organization owners and admins can do this in Console";
  if (needed === "editor") return "Your Console role is Viewer: you can look, not change";
  return CONSOLE_PEOPLE_ONLY_MESSAGE;
}

/** An API key (of any kind) or a product's end user: never a Console role. */
export function isConsoleKeyOrEndUser(context: AccessContext): boolean {
  return (
    context.subjectId.startsWith("api_key:") ||
    context.subjectId.startsWith("external_user:") ||
    accountScopedApiKeyWorkspaceAuthority(context) !== null
  );
}

/**
 * The signed-in person's Console access in this organization: `full` for
 * owners and admins, the stored role for a member signed in as themselves,
 * `none` for everyone and everything else.
 */
export async function resolveConsoleAccess(
  deps: Pick<ApiRouteDeps, "db">,
  context: AccessContext,
  organizationId: string,
): Promise<ConsoleAccessLevel> {
  if (isConsoleKeyOrEndUser(context)) return "none";
  if (holdsOrganizationAdministration(context, organizationId)) return "full";
  if (!holdsOrganizationMemberConsoleStanding(context, organizationId)) return "none";
  const role: ConsoleMemberRole = await getConsoleMemberRole(
    deps.db,
    organizationId,
    context.subjectId,
  );
  return role;
}

export type ConsoleCaller = {
  context: AccessContext;
  subjectId: string;
  label: string | null;
  access: Exclude<ConsoleAccessLevel, "none">;
};

/**
 * The caller, when their Console access covers `needed`; otherwise 403
 * `console_role_required`. API keys and end users are always refused here.
 */
export async function requireConsoleAccessForContext(
  deps: Pick<ApiRouteDeps, "db">,
  context: AccessContext,
  organizationId: string,
  needed: ConsoleAccess,
): Promise<ConsoleCaller> {
  if (isConsoleKeyOrEndUser(context)) throw refusal(CONSOLE_PEOPLE_ONLY_MESSAGE);
  const access = await resolveConsoleAccess(deps, context, organizationId);
  if (access === "none") throw refusal(CONSOLE_PEOPLE_ONLY_MESSAGE);
  if (!consoleAccessCovers(access, needed)) throw refusal(neededMessage(needed));
  return { context, subjectId: context.subjectId, label: context.subjectLabel ?? null, access };
}

export async function requireConsoleAccess(
  c: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  needed: ConsoleAccess,
): Promise<ConsoleCaller> {
  return await requireConsoleAccessForContext(
    deps,
    await requireAccessContext(c, deps),
    organizationId,
    needed,
  );
}

/** Refusal for a person whose Console access does not cover `needed` (organization agent routes). */
export function consoleRoleRefusal(needed: ConsoleAccess): ApiHttpError {
  return refusal(neededMessage(needed));
}

/**
 * Editors run test chats in the organization's Console test workspace as its
 * members. When a person's Console role drops below Editor (or they stop
 * being a member with one), that membership goes too, so a Console role never
 * leaves app workspace access behind. Best effort: a failure is logged.
 */
export async function revokeConsoleTestWorkspaceAccess(
  deps: ApiRouteDeps,
  input: { organizationId: string; subjectId: string; actorSubjectId: string },
): Promise<void> {
  try {
    const workspaceId = await findOrgAgentTestWorkspace(deps.db, input.organizationId);
    if (!workspaceId) return;
    await removeWorkspaceMember(deps.db, {
      accountId: input.organizationId,
      workspaceId,
      actorSubjectId: input.actorSubjectId,
      targetSubjectId: input.subjectId,
      requireOrganizationSharedWorkspaceAdministration: true,
    });
  } catch (error) {
    deps.observability?.warn("console test workspace access was not removed", {
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Resets a member's Console role to none (their organization role changed,
 * or they left), with its audit row, and removes Console test workspace
 * access an Editor had. Best effort: the membership change already happened.
 */
export async function resetConsoleRoleAfterMembershipChange(
  deps: ApiRouteDeps,
  input: {
    organizationId: string;
    subjectId: string;
    actorSubjectId: string;
    actorLabel: string | null;
    reason: string;
  },
): Promise<void> {
  if (!input.subjectId.startsWith("user:")) return;
  try {
    const previous = await clearConsoleMemberRole(deps.db, {
      accountId: input.organizationId,
      subjectId: input.subjectId,
      actorSubjectId: input.actorSubjectId,
      actorLabel: input.actorLabel,
      reason: input.reason,
    });
    if (previous === "editor") await revokeConsoleTestWorkspaceAccess(deps, input);
  } catch (error) {
    deps.observability?.warn("console role was not reset after a membership change", {
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const OrganizationIdParam = z.string().uuid();

function organizationIdOf(c: Context): string {
  const parsed = OrganizationIdParam.safeParse(c.req.param("organizationId"));
  if (!parsed.success) {
    throw new ApiHttpError(422, { code: "validation_failed", message: "invalid organizationId" });
  }
  return parsed.data.toLowerCase();
}

/**
 * `GET  /v1/organizations/:organizationId/console/access`: the caller's own
 *   Console access (any person in the organization; `none` when they have
 *   none). Keys and end users are refused.
 * `GET  /v1/organizations/:organizationId/console/member-roles`: every
 *   Console role set (owners and admins).
 * `PUT  /v1/organizations/:organizationId/console/member-roles`: set one
 *   member's or pending invitation's Console role (owners and admins).
 */
export function registerConsoleRoleRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/organizations/:organizationId/console";

  app.get(`${base}/access`, async (c) => {
    const organizationId = organizationIdOf(c);
    const context = await requireAccessContext(c, deps);
    if (isConsoleKeyOrEndUser(context)) throw refusal(CONSOLE_PEOPLE_ONLY_MESSAGE);
    const access = await resolveConsoleAccess(deps, context, organizationId);
    return c.json(ConsoleAccessResponse.parse({ organizationId, access }));
  });

  app.get(`${base}/member-roles`, async (c) => {
    const organizationId = organizationIdOf(c);
    await requireConsoleAccess(c, deps, organizationId, "full");
    const roles = await listConsoleMemberRoles(deps.db, organizationId);
    return c.json(ConsoleMemberRolesResponse.parse({ roles }));
  });

  app.put(`${base}/member-roles`, async (c) => {
    const organizationId = organizationIdOf(c);
    const admin = await requireConsoleAccess(c, deps, organizationId, "full");
    const request = await parseRequestJson(c, SetConsoleMemberRoleRequest);
    if (request.subjectId !== undefined) {
      // A current member of this organization whose organization role is
      // member: owners and admins are always full, and nobody else has one.
      const members = await listOrganizationAdministrationMembers(deps.db, {
        organizationId,
        actorSubjectId: admin.subjectId,
      });
      const member = members.find(
        (candidate) => candidate.subjectId === request.subjectId && candidate.status !== "revoked",
      );
      if (!member || !member.subjectId.startsWith("user:")) {
        throw new ApiHttpError(404, {
          code: "not_found",
          message: "Member not found",
          details: { code: "member_not_found" },
        });
      }
      if (member.role !== "member") {
        throw new ApiHttpError(422, {
          code: "validation_failed",
          message: "Owners and admins always have full Console access",
          details: { code: "console_role_not_applicable" },
        });
      }
    }
    try {
      const result = await setConsoleMemberRole(deps.db, {
        accountId: organizationId,
        target:
          request.subjectId !== undefined
            ? { subjectId: request.subjectId }
            : { invitationId: request.invitationId! },
        role: request.role,
        actorSubjectId: admin.subjectId,
        actorLabel: admin.label,
      });
      if (result.from === "editor" && request.role !== "editor" && request.subjectId) {
        await revokeConsoleTestWorkspaceAccess(deps, {
          organizationId,
          subjectId: request.subjectId,
          actorSubjectId: admin.subjectId,
        });
      }
      return c.json(result.entry);
    } catch (error) {
      if (error instanceof ConsoleRoleTargetNotFoundError) {
        throw new ApiHttpError(404, {
          code: "not_found",
          message: "Invitation not found",
          details: { code: "invitation_not_found" },
        });
      }
      throw error;
    }
  });
}
