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
 *
 * The one workspace a Console role touches is the organization's Console
 * test workspace (`organization_managed_workspaces.source = 'console_test'`),
 * where Editors and owners and admins run test chats. Their membership there
 * holds only `CONSOLE_TEST_WORKSPACE_PERMISSIONS` (never `workspace:admin`,
 * so it never stands for `agents:manage` or any other administration), it is
 * removed whenever their Console access drops below Editor, and an
 * organization agent chat there needs Editor access at the moment it starts
 * (`requireConsoleTestChatStanding`), so a membership left behind is not
 * enough.
 */
import { orgAgentsEnabledForAccount } from "@opengeni/config";
import {
  ConsoleAccessResponse,
  ConsoleMemberRolesResponse,
  SetConsoleMemberRoleRequest,
  type AccessContext,
  type ConsoleAccessLevel,
  type ConsoleMemberRole,
  type Permission,
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
 * What a person's membership of the Console test workspace holds: start,
 * read and steer chats there. Nothing that administers the workspace or the
 * organization (no `workspace:admin`, members, keys, secrets, connections or
 * tool attachments), so it never satisfies `agents:manage`, even where a
 * legacy permission check would expand `workspace:admin`.
 */
export const CONSOLE_TEST_WORKSPACE_PERMISSIONS: readonly Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
];

/** Error `details.code` when Console test workspace access could not be removed. */
export const CONSOLE_ACCESS_CLEANUP_FAILED = "console_access_cleanup_failed";

function cleanupFailed(message: string): ApiHttpError {
  return new ApiHttpError(503, {
    code: "internal_error",
    message,
    retryable: true,
    details: { code: CONSOLE_ACCESS_CLEANUP_FAILED },
  });
}

/**
 * Editors (and owners and admins) run test chats in the organization's
 * Console test workspace as its members. When a person's Console access drops
 * below Editor, that membership goes, whatever role was stored, so a Console
 * role never leaves app workspace access behind. Removing a membership that
 * is already gone succeeds. A failure is a retryable 503
 * (`console_access_cleanup_failed`): repeating the same request removes it.
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
    deps.observability?.error("console test workspace access was not removed", {
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw cleanupFailed(
      "The change was saved, but this person's Console test chat access wasn't removed. Try again.",
    );
  }
}

/**
 * After an organization role change or offboarding: resets the person's
 * Console role to none, with its audit row, and removes their Console test
 * workspace access unless they are still an owner or admin (still full). Runs
 * whatever was stored, so a demoted owner or admin (who has no stored role)
 * loses it too. A failure is a retryable 503: the membership change itself
 * is saved, and repeating the request with the same `operationId` repeats
 * this cleanup.
 */
export async function resetConsoleRoleAfterMembershipChange(
  deps: ApiRouteDeps,
  input: {
    organizationId: string;
    subjectId: string;
    actorSubjectId: string;
    actorLabel: string | null;
    reason: string;
    /** Their organization role now, or null when they left. */
    organizationRole: string | null;
  },
): Promise<void> {
  if (!input.subjectId.startsWith("user:")) return;
  try {
    await clearConsoleMemberRole(deps.db, {
      accountId: input.organizationId,
      subjectId: input.subjectId,
      actorSubjectId: input.actorSubjectId,
      actorLabel: input.actorLabel,
      reason: input.reason,
    });
  } catch (error) {
    deps.observability?.error("console role was not reset after a membership change", {
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw cleanupFailed(
      "The change was saved, but this person's Console role wasn't reset. Try again.",
    );
  }
  if (input.organizationRole === "owner" || input.organizationRole === "admin") return;
  await revokeConsoleTestWorkspaceAccess(deps, input);
}

/**
 * An organization agent chat in the Console test workspace (drafts run only
 * there) needs, when it starts, an organization API key or a person with
 * Editor access or more, checked now rather than from their membership. Any
 * other workspace, or an organization without Console agents, is unaffected.
 */
export async function requireConsoleTestChatStanding(
  deps: ApiRouteDeps,
  c: Context,
  input: { accountId: string; workspaceId: string },
): Promise<void> {
  if (!orgAgentsEnabledForAccount(deps.settings, input.accountId)) return;
  const testWorkspaceId = await findOrgAgentTestWorkspace(deps.db, input.accountId);
  if (!testWorkspaceId || testWorkspaceId.toLowerCase() !== input.workspaceId.toLowerCase()) {
    return;
  }
  const context = await requireAccessContext(c, deps);
  const organizationKey = accountScopedApiKeyWorkspaceAuthority(context);
  if (organizationKey && organizationKey.accountId === input.accountId) return;
  await requireConsoleAccessForContext(deps, context, input.accountId, "editor");
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
      // Anything below Editor: no Console test workspace access, whatever was
      // stored before (a retry after a failed removal removes it then).
      if (request.role !== "editor" && request.subjectId) {
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
