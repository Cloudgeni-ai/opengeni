// Console roles (docs/opengeni-console.md, "Roles"): what the signed-in
// person may do in an organization's Console, and the calls that read and set
// members' Console roles. Owners and admins are always `full`; a member has
// the role an owner or admin set (`viewer`, `editor`) or `none`. The API
// checks every call; this only shapes what Console shows.
import type {
  ConsoleAccessLevel,
  ConsoleAccessResponse,
  ConsoleMemberRole,
  ConsoleMemberRoleEntry,
  ConsoleMemberRolesResponse,
} from "@opengeni/contracts";
import { useSharedQuery } from "@opengeni/react/app/lib/shared-query";

import type { OrgAgentsTransport } from "./organization-agents";

export type { ConsoleAccessLevel, ConsoleMemberRole, ConsoleMemberRoleEntry };

const RANK: Record<ConsoleAccessLevel, number> = { none: 0, viewer: 1, editor: 2, full: 3 };

/** Whether `access` allows what needs `needed`. */
export function consoleAccessCovers(
  access: ConsoleAccessLevel | null | undefined,
  needed: Exclude<ConsoleAccessLevel, "none">,
): boolean {
  return access ? RANK[access] >= RANK[needed] : false;
}

/** "Viewer", "Editor"; owners and admins read "Full". */
export function consoleRoleLabel(role: ConsoleAccessLevel): string {
  switch (role) {
    case "full":
      return "Full";
    case "editor":
      return "Editor";
    case "viewer":
      return "Viewer";
    case "none":
      return "None";
  }
}

function base(organizationId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationId)}/console`;
}

export function consoleRolesApi(client: OrgAgentsTransport, organizationId: string) {
  return {
    getAccess: (signal?: AbortSignal) =>
      client.requestJson<ConsoleAccessResponse>(
        "GET",
        `${base(organizationId)}/access`,
        undefined,
        {},
        signal ? { signal } : {},
      ),
    listMemberRoles: (signal?: AbortSignal) =>
      client.requestJson<ConsoleMemberRolesResponse>(
        "GET",
        `${base(organizationId)}/member-roles`,
        undefined,
        {},
        signal ? { signal } : {},
      ),
    setMemberRole: (
      target: { subjectId: string } | { invitationId: string },
      role: ConsoleMemberRole,
    ) =>
      client.requestJson<ConsoleMemberRoleEntry>("PUT", `${base(organizationId)}/member-roles`, {
        ...target,
        role,
      }),
  };
}

/**
 * The signed-in person's Console access in each of these organizations:
 * `full` where they administer it, otherwise what the API answers (`none`
 * when it refuses or fails). Null until known.
 */
export function useConsoleAccessByOrganization(
  client: OrgAgentsTransport,
  organizations: readonly { accountId: string; canAdminister: boolean }[],
): Record<string, ConsoleAccessLevel> | null {
  const asked = organizations.filter((org) => !org.canAdminister).map((org) => org.accountId);
  const query = useSharedQuery(
    client,
    ["console", "access", ...asked],
    async (signal) => {
      const entries = await Promise.all(
        asked.map(async (organizationId): Promise<[string, ConsoleAccessLevel]> => {
          try {
            const response = await consoleRolesApi(client, organizationId).getAccess(signal);
            return [organizationId, response.access];
          } catch (error) {
            if (signal.aborted) throw error;
            return [organizationId, "none"];
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, ConsoleAccessLevel>;
    },
    { enabled: asked.length > 0, staleTimeMs: 60_000 },
  );
  const known = asked.length === 0 ? {} : query.data;
  if (!known) return query.error ? accessFrom(organizations, {}) : null;
  return accessFrom(organizations, known);
}

function accessFrom(
  organizations: readonly { accountId: string; canAdminister: boolean }[],
  asked: Record<string, ConsoleAccessLevel>,
): Record<string, ConsoleAccessLevel> {
  return Object.fromEntries(
    organizations.map((org) => [
      org.accountId,
      org.canAdminister ? "full" : (asked[org.accountId] ?? "none"),
    ]),
  );
}

/** Members' Console roles (owners and admins only; null while loading or refused). */
export function useConsoleMemberRoles(
  client: OrgAgentsTransport,
  organizationId: string | null,
  enabled: boolean,
) {
  return useSharedQuery(
    client,
    ["console", "member-roles", organizationId],
    (signal) => consoleRolesApi(client, organizationId ?? "").listMemberRoles(signal),
    { enabled: enabled && Boolean(organizationId), staleTimeMs: 30_000 },
  );
}
