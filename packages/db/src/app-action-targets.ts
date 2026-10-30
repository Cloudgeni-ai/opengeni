import {
  appActionCallPathIds,
  type AppActionTarget,
  type AppActionTargets,
} from "@opengeni/contracts/app-actions";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { and, eq, isNull, ne, or, sql, type AnyColumn } from "drizzle-orm";
import {
  setSubjectRlsContext,
  withAccountRls,
  withRlsContext,
  withWorkspaceSubjectRls,
  type Database,
} from "./database";
import { connectionSubjectVisibility } from "./connection-metadata";
import { listOrganizationMcpConnections } from "./mcp-oauth";
import {
  getOrganizationInvitationForAdministration,
  listOrganizationMembers,
  listSelfOrganizationMemberships,
} from "./organization-membership-lifecycle";
import { accountPermissionsForOrganizationRole } from "./organization-role-permissions";
import { getVault, getVaultItem, VaultError, type VaultDbContext } from "./vaults";
import { normalizeWorkspaceMembershipPermissions } from "./workspace-membership-permissions";
import * as schema from "./schema";

/**
 * What an app action changes, read from Opengeni's own records when its
 * approval is prepared, so the card can name it ("Remove the Gmail connection
 * for anna@example.com?"). Only ids from the call's path are looked up, only
 * in the chat's own organization, and as the person the chat acts for: what
 * they can't see stays unresolved, never someone else's name, and "not found"
 * follows only a lookup that sees what they see. Nothing
 * the agent wrote becomes a name. A lookup that fails leaves the id
 * unresolved, so the card keeps its plain wording instead of guessing.
 */
export async function resolveAppActionTargets(
  db: Database,
  scope: {
    accountId: string;
    /** The chat's workspace, where the person is known to act. */
    workspaceId: string;
    /** The person the chat acts for; nothing is read without one. */
    subjectId: string | null;
    /** Told about a lookup that failed; its id stays unresolved. */
    onLookupError?: (error: unknown, parameter: string) => void;
    /** How long one lookup may take before the card asks without it. */
    timeoutMs?: number;
  },
  args: unknown,
): Promise<AppActionTargets> {
  const call = appActionCallPathIds(args);
  const subjectId = scope.subjectId;
  if (!call || !subjectId) return {};
  const segments = call.entry.path.split("/");
  // Read live, once per call, as the API's routes read them: a turn's frozen
  // permissions can imply account:admin for a workspace admin.
  let role: Promise<readonly string[]> | undefined;
  const organizationPermissions = () =>
    (role ??= liveOrganizationPermissions(db, scope.accountId, subjectId).catch(
      (error: unknown) => {
        scope.onLookupError?.(error, "organizationRole");
        return [];
      },
    ));
  const memberships = new Map<string, Promise<readonly string[] | null>>();
  const workspacePermissions = (workspaceId: string) => {
    let read = memberships.get(workspaceId);
    if (!read) {
      read = membershipPermissions(db, scope.accountId, workspaceId, subjectId);
      memberships.set(workspaceId, read);
    }
    return read;
  };
  const found = await Promise.all(
    Object.entries(call.ids).map(async ([parameter, id]) => {
      // The chat's own workspace reads as "this workspace"; nothing to look up.
      if (parameter === "workspaceId" && id === scope.workspaceId) return null;
      const lookup = lookupFor(segments, parameter);
      if (!lookup) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const target = await Promise.race([
          lookup({
            db,
            accountId: scope.accountId,
            chatWorkspaceId: scope.workspaceId,
            subjectId,
            organizationPermissions,
            workspacePermissions,
            ids: call.ids,
            id,
            organization: segments[2] === "organizations",
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`the ${parameter} lookup took too long`)),
              scope.timeoutMs ?? LOOKUP_TIMEOUT_MS,
            );
          }),
        ]);
        return [parameter, target] as const;
      } catch (error) {
        if (!(error instanceof Unresolved)) scope.onLookupError?.(error, parameter);
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return Object.fromEntries(found.filter((entry) => entry !== null));
}

const LOOKUP_TIMEOUT_MS = 3_000;

/** The account permissions the person's active role in the chat's organization holds, right now. */
async function liveOrganizationPermissions(
  db: Database,
  accountId: string,
  subjectId: string,
): Promise<readonly string[]> {
  const membership = (await listSelfOrganizationMemberships(db, subjectId)).find(
    (candidate) => candidate.organizationId === accountId && candidate.status === "active",
  );
  return membership ? accountPermissionsForOrganizationRole(membership.role) : [];
}

/**
 * The person's permissions in a workspace, as the API's workspace grant reads
 * them (its membership's permissions, never its role label), or null for
 * someone who isn't a member.
 */
async function membershipPermissions(
  db: Database,
  accountId: string,
  workspaceId: string,
  subjectId: string,
): Promise<readonly string[] | null> {
  return await withAccountRls(db, accountId, async (scoped) => {
    const [found] = await scoped
      .select({ permissions: schema.workspaceMemberships.permissions })
      .from(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.accountId, accountId),
          eq(schema.workspaceMemberships.workspaceId, workspaceId),
          eq(schema.workspaceMemberships.subjectId, subjectId),
        ),
      )
      .limit(1);
    return found ? normalizeWorkspaceMembershipPermissions(found.permissions) : null;
  });
}

/** As hasPermission reads a person's grant: the permission itself, or workspace:admin. */
function holds(permissions: readonly string[] | null, permission: string): boolean {
  return Boolean(permissions?.includes(permission) || permissions?.includes("workspace:admin"));
}

/**
 * The lookup can't read this as the person (no workspace in the route, a
 * workspace they don't act in, an organization record without admin), so the
 * id stays unresolved and the card keeps its plain wording: never a name they
 * couldn't see, and never "not found" for something that may exist.
 */
class Unresolved extends Error {}
function unresolved(): never {
  throw new Unresolved("unresolved");
}

type LookupContext = {
  db: Database;
  accountId: string;
  /** The chat's own workspace. */
  chatWorkspaceId: string;
  subjectId: string;
  /** Their account permissions in the chat's organization, from their live role. */
  organizationPermissions: () => Promise<readonly string[]>;
  /** Their permissions in a workspace, from its membership; null when they aren't a member. */
  workspacePermissions: (workspaceId: string) => Promise<readonly string[] | null>;
  /** Every path id of the call, by parameter. */
  ids: Record<string, string>;
  /** The id this lookup resolves. */
  id: string;
  /** The route lives under /v1/organizations/:organizationId. */
  organization: boolean;
};
type Lookup = (where: LookupContext) => Promise<AppActionTarget>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Oct 2026", in UTC. */
export function targetDay(value: Date | string | null | undefined): string | undefined {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "14 Oct 2026, 07:41 UTC". */
export function targetMoment(value: Date | string | null | undefined): string | undefined {
  const day = targetDay(value);
  if (!day) return undefined;
  const date = new Date(value!);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

type Fact = { label: string; value: string };
function facts(...entries: Array<[string, string | null | undefined]>): Fact[] {
  return entries.flatMap(([label, value]) =>
    typeof value === "string" && value.trim() ? [{ label, value: value.trim() }] : [],
  );
}

function missing(kind: string): AppActionTarget {
  return { kind };
}

/** The workspace the call names, read as the person the chat acts for. */
async function inWorkspace<T>(
  where: LookupContext,
  run: (db: Database, workspaceId: string) => Promise<T | null>,
): Promise<T | null> {
  const workspaceId = where.ids.workspaceId;
  if (!workspaceId) unresolved();
  if (!UUID.test(workspaceId)) unresolved();
  // Outside the organization, or not theirs to act in: it may well exist.
  if (!(await ownsWorkspace(where, workspaceId))) unresolved();
  if (!(await actsIn(where, workspaceId))) unresolved();
  return await withWorkspaceSubjectRls(where.db, workspaceId, where.subjectId, (db) =>
    run(db, workspaceId),
  );
}

/**
 * The person reads this workspace: it's the chat's own (their access was
 * checked for this turn), or their membership grants workspace:read. An
 * organization role reaches no further into workspaces, as in the API.
 */
async function actsIn(where: LookupContext, workspaceId: string): Promise<boolean> {
  if (workspaceId === where.chatWorkspaceId) return true;
  return holds(await where.workspacePermissions(workspaceId), "workspace:read");
}

/** Organization records are read only by someone whose role holds one of these, as its route requires. */
async function organizationMay(where: LookupContext, ...permissions: string[]): Promise<void> {
  const held = await where.organizationPermissions();
  if (!permissions.some((permission) => held.includes(permission))) unresolved();
}

/** Only the chat's own organization is read; another's may exist, so it stays unresolved. */
function ownOrganization(where: LookupContext): void {
  if (where.ids.organizationId !== where.accountId) unresolved();
}

/**
 * The person manages this workspace's keys (api_keys:manage) or webhooks
 * (workspace settings, workspace:admin), as their routes require, from their
 * membership's permissions.
 */
async function managesWorkspace(
  where: LookupContext,
  workspaceId: string | undefined,
  permission: "api_keys:manage" | "workspace:admin",
): Promise<void> {
  if (!workspaceId || !UUID.test(workspaceId)) unresolved();
  if (!holds(await where.workspacePermissions(workspaceId), permission)) unresolved();
}

/** Shared with the workspace, or the person's own. */
function visibleTo(
  table: { visibility: AnyColumn; ownerSubjectId: AnyColumn },
  subjectId: string,
  shared = "workspace_shared",
) {
  return or(eq(table.visibility, shared), eq(table.ownerSubjectId, subjectId));
}

/** The workspace belongs to the chat's organization. */
async function ownsWorkspace(where: LookupContext, workspaceId: string): Promise<boolean> {
  return await withAccountRls(where.db, where.accountId, async (db) => {
    const [row] = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.accountId, where.accountId),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

/** A row of a workspace table by uuid, or not found. */
function workspaceRow<T>(
  kind: string,
  read: (
    db: Database,
    workspaceId: string,
    id: string,
    where: LookupContext,
  ) => Promise<T | undefined>,
  target: (row: T, where: LookupContext) => AppActionTarget,
): Lookup {
  return async (where) => {
    if (!UUID.test(where.id)) return missing(kind);
    const row = await inWorkspace(
      where,
      async (db, workspaceId) => (await read(db, workspaceId, where.id, where)) ?? null,
    );
    return row ? target(row, where) : missing(kind);
  };
}

/** A row of an organization table by uuid, only in the chat's own organization, for a role its route allows. */
function organizationRow<T>(
  kind: string,
  permissions: string[],
  read: (db: Database, accountId: string, id: string) => Promise<T | undefined>,
  target: (row: T) => AppActionTarget,
): Lookup {
  return async (where) => {
    ownOrganization(where);
    await organizationMay(where, ...permissions);
    if (!UUID.test(where.id)) return missing(kind);
    const row = await withAccountRls(where.db, where.accountId, (db) =>
      read(db, where.accountId, where.id),
    );
    return row ? target(row) : missing(kind);
  };
}

const workspaceLookup: Lookup = async (where) => {
  if (!UUID.test(where.id)) return missing("workspace");
  if (!(await ownsWorkspace(where, where.id))) unresolved();
  // Its name is a member's to see, or an organization admin's, whose pages list workspaces.
  if (!(await actsIn(where, where.id)))
    await organizationMay(where, "members:manage", "account:admin");
  const row = await withAccountRls(where.db, where.accountId, async (db) => {
    const [found] = await db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(
        and(eq(schema.workspaces.id, where.id), eq(schema.workspaces.accountId, where.accountId)),
      )
      .limit(1);
    return found;
  });
  return row ? { kind: "workspace", name: row.name } : missing("workspace");
};

const organizationLookup: Lookup = async (where) => {
  if (where.id !== where.accountId) unresolved();
  const row = await withAccountRls(where.db, where.accountId, async (db) => {
    const [found] = await db
      .select({ name: schema.managedAccounts.name })
      .from(schema.managedAccounts)
      .where(eq(schema.managedAccounts.id, where.accountId))
      .limit(1);
    return found;
  });
  return row ? { kind: "organization", name: row.name } : missing("organization");
};

const sessionLookup = workspaceRow(
  "chat",
  async (db, workspaceId, id, where) =>
    (
      await db
        .select({ title: schema.sessions.title, createdAt: schema.sessions.createdAt })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, id),
            eq(schema.sessions.workspaceId, workspaceId),
            visibleTo(schema.sessions, where.subjectId),
          ),
        )
        .limit(1)
    )[0],
  (row) => ({
    kind: "chat",
    name: row.title?.trim() || "Untitled chat",
    facts: facts(["Started", targetMoment(row.createdAt)]),
  }),
);

const CONNECTION_STATUS: Record<string, string> = {
  needs_reauth: "Needs reconnecting",
  error: "Not working",
  revoked: "Already removed",
};

/** The integration's name for a provider, from the shared catalog only. */
async function integrationName(db: Database, providerDomain: string): Promise<string> {
  const rows = await db
    .selectDistinct({ name: schema.capabilityCatalogItems.name })
    .from(schema.capabilityCatalogItems)
    .where(
      and(
        eq(schema.capabilityCatalogItems.providerDomain, providerDomain),
        isNull(schema.capabilityCatalogItems.accountId),
      ),
    )
    .limit(2);
  // Two products on one domain can't be told apart by it; the domain is true.
  return rows.length === 1 && rows[0]!.name.trim() ? rows[0]!.name.trim() : providerDomain;
}

const connectionLookup = workspaceRow(
  "connection",
  async (db, workspaceId, id, where) => {
    const [row] = await db
      .select({
        providerDomain: schema.connections.providerDomain,
        status: schema.connections.status,
        subjectId: schema.connections.subjectId,
        metadata: schema.connections.metadata,
        createdAt: schema.connections.createdAt,
        lastUsedAt: schema.connections.lastUsedAt,
      })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.id, id),
          eq(schema.connections.workspaceId, workspaceId),
          // Someone else's own connection is theirs alone, as the API reads it.
          connectionSubjectVisibility(where.subjectId),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return { ...row, name: await integrationName(db, row.providerDomain) };
  },
  (row) => {
    const account = connectionAccountIdentityLabel(
      (row.metadata ?? {}) as Record<string, unknown>,
      "",
    );
    return {
      kind: "connection",
      name: row.name,
      ...(account ? { account } : {}),
      facts: facts(
        ["Status", CONNECTION_STATUS[row.status]],
        [
          "Who can use it",
          // Only shared ones and the person's own are found at all.
          row.subjectId === null ? "Everyone in this workspace" : "Only you",
        ],
        ["Added", targetMoment(row.createdAt)],
        ["Last used", targetDay(row.lastUsedAt) ?? "Never"],
      ),
    };
  },
);

const SOCIAL_NAMES: Record<string, string> = { x: "X", reddit: "Reddit", linkedin: "LinkedIn" };
const socialConnectionLookup = workspaceRow(
  "connection",
  async (db, workspaceId, id) =>
    (
      await db
        .select({
          provider: schema.socialConnections.provider,
          handle: schema.socialConnections.accountHandle,
          accountName: schema.socialConnections.accountName,
          createdAt: schema.socialConnections.createdAt,
        })
        .from(schema.socialConnections)
        .where(
          and(
            eq(schema.socialConnections.id, id),
            eq(schema.socialConnections.workspaceId, workspaceId),
          ),
        )
        .limit(1)
    )[0],
  (row) => {
    const account = row.handle?.trim() || row.accountName?.trim();
    return {
      kind: "connection",
      name: SOCIAL_NAMES[row.provider] ?? row.provider,
      ...(account ? { account } : {}),
      facts: facts(["Added", targetMoment(row.createdAt)]),
    };
  },
);

const organizationMcpConnectionLookup: Lookup = async (where) => {
  ownOrganization(where);
  await organizationMay(where, "account:admin");
  if (!UUID.test(where.id)) return missing("connected app");
  const [row] = await listOrganizationMcpConnections(where.db, {
    accountId: where.accountId,
    connectionId: where.id,
  });
  return row
    ? {
        kind: "connected app",
        name: row.clientName?.trim() || "Unnamed app",
        facts: facts(
          ["Connected", targetMoment(row.connectedAt)],
          ["Last used", targetDay(row.lastUsedAt) ?? "Never"],
        ),
      }
    : missing("connected app");
};

const siteLookup = workspaceRow(
  "Site",
  async (db, workspaceId, id, where) =>
    (
      await db
        .select({
          title: schema.workspaceArtifacts.title,
          slug: schema.workspaceArtifacts.slug,
          updatedAt: schema.workspaceArtifacts.updatedAt,
        })
        .from(schema.workspaceArtifacts)
        .where(
          and(
            eq(schema.workspaceArtifacts.id, id),
            eq(schema.workspaceArtifacts.workspaceId, workspaceId),
            visibleTo(schema.workspaceArtifacts, where.subjectId),
          ),
        )
        .limit(1)
    )[0],
  (row) => ({
    kind: "Site",
    name: row.title?.trim() || row.slug,
    facts: facts(["Last changed", targetMoment(row.updatedAt)]),
  }),
);

const DAY_NAMES: Record<string, string> = {
  MONDAY: "Mondays",
  TUESDAY: "Tuesdays",
  WEDNESDAY: "Wednesdays",
  THURSDAY: "Thursdays",
  FRIDAY: "Fridays",
  SATURDAY: "Saturdays",
  SUNDAY: "Sundays",
};

/** "Mondays at 08:00 (Europe/Oslo)", "Every 2 hours", "Only when started". */
export function scheduleSummary(schedule: unknown): string | undefined {
  if (!schedule || typeof schedule !== "object") return undefined;
  const spec = schedule as Record<string, unknown>;
  const pad = (n: unknown) => String(n).padStart(2, "0");
  switch (spec.type) {
    case "manual":
      return "Only when started";
    case "once": {
      const at = targetMoment(typeof spec.runAt === "string" ? spec.runAt : undefined);
      return at ? `Once, ${at}` : undefined;
    }
    case "interval": {
      const seconds = Number(spec.everySeconds);
      if (!Number.isInteger(seconds) || seconds <= 0) return undefined;
      const [unit, size] =
        seconds % 86_400 === 0
          ? (["day", 86_400] as const)
          : seconds % 3_600 === 0
            ? (["hour", 3_600] as const)
            : seconds % 60 === 0
              ? (["minute", 60] as const)
              : (["second", 1] as const);
      const count = seconds / size;
      return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
    }
    case "calendar": {
      if (!Number.isInteger(spec.hour) || !Number.isInteger(spec.minute)) return undefined;
      const days = Array.isArray(spec.daysOfWeek)
        ? spec.daysOfWeek.flatMap((day) =>
            DAY_NAMES[String(day)] ? [DAY_NAMES[String(day)]!] : [],
          )
        : [];
      const when =
        days.length === 0 || days.length === 7
          ? "Every day"
          : days.length === 1
            ? days[0]!
            : `${days.slice(0, -1).join(", ")} and ${days.at(-1)}`;
      const zone = typeof spec.timeZone === "string" ? spec.timeZone : "UTC";
      return `${when} at ${pad(spec.hour)}:${pad(spec.minute)} (${zone})`;
    }
    default:
      return undefined;
  }
}

const scheduledTaskLookup = workspaceRow(
  "scheduled task",
  async (db, workspaceId, id, where) =>
    (
      await db
        .select({
          name: schema.scheduledTasks.name,
          status: schema.scheduledTasks.status,
          schedule: schema.scheduledTasks.schedule,
          createdAt: schema.scheduledTasks.createdAt,
        })
        .from(schema.scheduledTasks)
        .where(
          and(
            eq(schema.scheduledTasks.id, id),
            eq(schema.scheduledTasks.workspaceId, workspaceId),
            isNull(schema.scheduledTasks.deletedAt),
            visibleTo(schema.scheduledTasks, where.subjectId),
          ),
        )
        .limit(1)
    )[0],
  (row) => ({
    kind: "scheduled task",
    name: row.name,
    facts: facts(
      ["Runs", scheduleSummary(row.schedule)],
      ["Status", row.status === "paused" ? "Paused" : undefined],
      ["Created", targetMoment(row.createdAt)],
    ),
  }),
);

const apiKeyLookup: Lookup = async (where) => {
  if (!UUID.test(where.id)) return missing("API key");
  const read = async (db: Database) =>
    (
      await db
        .select({
          name: schema.apiKeys.name,
          prefix: schema.apiKeys.prefix,
          workspaceId: schema.apiKeys.workspaceId,
          lastUsedAt: schema.apiKeys.lastUsedAt,
          expiresAt: schema.apiKeys.expiresAt,
          revokedAt: schema.apiKeys.revokedAt,
          credentialKind: schema.apiKeys.credentialKind,
          ownerSubjectId: schema.apiKeys.ownerSubjectId,
        })
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.id, where.id), eq(schema.apiKeys.accountId, where.accountId)))
        .limit(1)
    )[0];
  if (where.organization) ownOrganization(where);
  const row = where.organization
    ? await withAccountRls(where.db, where.accountId, read)
    : ((await inWorkspace(where, async (db, workspaceId) => {
        const found = await read(db);
        return found && found.workspaceId === workspaceId ? found : null;
      })) ?? undefined);
  // As the API reads them: a personal key is its owner's and an organization
  // admin's to see, an organization's keys are an admin's, and a workspace's
  // keys are for whoever manages them there.
  const ownKey = row?.credentialKind === "personal" && row.ownerSubjectId === where.subjectId;
  if (!ownKey) {
    if (row?.credentialKind === "personal") await organizationMay(where, "account:admin");
    else if (where.organization) await organizationMay(where, "api_keys:manage", "account:admin");
    else await managesWorkspace(where, where.ids.workspaceId, "api_keys:manage");
  }
  return row
    ? {
        kind: "API key",
        name: row.name,
        facts: facts(
          ["Starts with", row.prefix ? `${row.prefix}…` : undefined],
          ["Status", row.revokedAt ? "Already revoked" : undefined],
          ["Last used", targetDay(row.lastUsedAt) ?? "Never"],
          ["Expires", targetDay(row.expiresAt)],
        ),
      }
    : missing("API key");
};

const ROLE_NAMES: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
  operator: "Operator",
};
const roleName = (role: unknown) =>
  typeof role === "string" ? (ROLE_NAMES[role] ?? role) : undefined;

const workspaceMemberLookup: Lookup = async (where) => {
  const row = await inWorkspace(where, async (db, workspaceId) => {
    const [found] = await db
      .select({
        label: schema.workspaceMemberships.subjectLabel,
        role: schema.workspaceMemberships.role,
        createdAt: schema.workspaceMemberships.createdAt,
      })
      .from(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, workspaceId),
          eq(schema.workspaceMemberships.subjectId, where.id),
        ),
      )
      .limit(1);
    return found ?? null;
  });
  return row
    ? {
        kind: "member",
        name: row.label?.trim() || "A member without a name",
        facts: facts(["Role", roleName(row.role)], ["Member since", targetDay(row.createdAt)]),
      }
    : missing("member");
};

/** The chat's own organization, read through its member routines as the person the chat acts for. */
function organizationRoutine<T>(
  kind: string,
  read: (
    db: Database,
    input: { organizationId: string; actorSubjectId: string; id: string },
  ) => Promise<T | undefined>,
  target: (row: T) => AppActionTarget,
): Lookup {
  return async (where) => {
    ownOrganization(where);
    await organizationMay(where, "members:manage", "account:admin");
    if (!UUID.test(where.id)) return missing(kind);
    const row = await read(where.db, {
      organizationId: where.accountId,
      actorSubjectId: where.subjectId,
      id: where.id,
    });
    return row ? target(row) : missing(kind);
  };
}

const organizationMemberLookup = organizationRoutine(
  "member",
  async (db, { organizationId, actorSubjectId, id }) =>
    (await listOrganizationMembers(db, { organizationId, actorSubjectId })).find(
      (member) => member.id === id,
    ),
  (row) => ({
    kind: "member",
    name: row.email?.trim() || row.name?.trim() || "A member without a name",
    facts: facts(
      ["Name", row.email?.trim() ? row.name?.trim() : undefined],
      ["Role", roleName(row.role)],
      ["Status", row.status === "active" ? undefined : row.status],
    ),
  }),
);
const invitationLookup = organizationRoutine(
  "invitation",
  async (db, { organizationId, actorSubjectId, id }) => {
    try {
      return await getOrganizationInvitationForAdministration(db, {
        organizationId,
        actorSubjectId,
        invitationId: id,
      });
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  },
  (row) => ({
    kind: "invitation",
    name: row.targetEmail.trim() || row.targetName?.trim() || "Someone without an email",
    facts: facts(
      ["Name", row.targetName?.trim()],
      ["Role", roleName(row.role)],
      ["Expires", targetDay(row.expiresAt)],
    ),
  }),
);

/** A vault, read through the vault routines as the person the chat acts for. */
const vaultLookup: Lookup = async (where) => {
  if (!UUID.test(where.id)) return missing("vault");
  const vault = await asVaultReader(where, (context) =>
    getVault(where.db, context, { vaultId: where.id }),
  );
  return vault
    ? { kind: "vault", name: vault.name, facts: facts(["Belongs to", vault.ownerLabel]) }
    : missing("vault");
};

const vaultItemLookup: Lookup = async (where) => {
  if (!UUID.test(where.id)) return missing("vault item");
  const item = await asVaultReader(where, (context) =>
    getVaultItem(where.db, context, { itemId: where.id }),
  );
  return item && (!where.ids.vaultId || where.ids.vaultId === item.vaultId)
    ? {
        kind: "vault item",
        name: item.name,
        facts: facts(["Vault", item.vaultName], ["Type", item.type.replaceAll("_", " ")]),
      }
    : missing("vault item");
};

async function asVaultReader<T>(
  where: LookupContext,
  read: (context: VaultDbContext) => Promise<T>,
): Promise<T | undefined> {
  const workspaceId = where.ids.workspaceId;
  if (!workspaceId || !UUID.test(workspaceId)) unresolved();
  if (!(await ownsWorkspace(where, workspaceId)) || !(await actsIn(where, workspaceId)))
    unresolved();
  try {
    return await read({
      kind: "subject",
      accountId: where.accountId,
      workspaceId,
      subjectId: where.subjectId,
    });
  } catch (error) {
    if (
      error instanceof VaultError &&
      (error.code === "vault_not_found" || error.code === "vault_item_not_found")
    )
      return undefined;
    throw error;
  }
}

/** A routine's "not found" refusal (SQLSTATE P0002 or a 404 code), as opposed to a failure. */
function notFound(error: unknown): boolean {
  for (
    let cause = error as { code?: unknown; cause?: unknown; message?: unknown } | undefined;
    cause;
    cause = cause.cause as typeof cause
  ) {
    if (cause.code === "P0002") return true;
    if (typeof cause.message === "string" && /not[ _]found/iu.test(cause.message)) return true;
  }
  return false;
}

/** Only the host: an incoming webhook's path is often its secret. */
function webhookHost(url: string): string {
  try {
    return new URL(url).host || "a webhook";
  } catch {
    return "a webhook";
  }
}

const webhookLookup: Lookup = async (where) => {
  if (!UUID.test(where.id)) return missing("webhook");
  if (where.organization) {
    ownOrganization(where);
    await organizationMay(where, "account:admin");
  } else {
    await managesWorkspace(where, where.ids.workspaceId, "workspace:admin");
  }
  const row = where.organization
    ? await withAccountRls(
        where.db,
        where.accountId,
        async (db) =>
          (
            await db
              .select({
                url: schema.organizationWebhooks.url,
                description: schema.organizationWebhooks.description,
                enabled: schema.organizationWebhooks.enabled,
              })
              .from(schema.organizationWebhooks)
              .where(
                and(
                  eq(schema.organizationWebhooks.id, where.id),
                  eq(schema.organizationWebhooks.accountId, where.accountId),
                ),
              )
              .limit(1)
          )[0],
      )
    : ((await inWorkspace(where, async (db, workspaceId) => {
        const [found] = await db
          .select({
            url: schema.workspaceWebhooks.url,
            description: schema.workspaceWebhooks.description,
            enabled: schema.workspaceWebhooks.enabled,
          })
          .from(schema.workspaceWebhooks)
          .where(
            and(
              eq(schema.workspaceWebhooks.id, where.id),
              eq(schema.workspaceWebhooks.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        return found ?? null;
      })) ?? undefined);
  if (!row) return missing("webhook");
  const host = webhookHost(row.url);
  return {
    kind: "webhook",
    name: row.description?.trim() || host,
    facts: facts(
      ["Sends to", row.description?.trim() ? host : undefined],
      ["Status", row.enabled ? undefined : "Off"],
    ),
  };
};

/** A workspace table with a name column, looked up by uuid. */
function named(
  kind: string,
  table:
    | typeof schema.rigs
    | typeof schema.channels
    | typeof schema.documentBases
    | typeof schema.botTemplates
    | typeof schema.automationTemplates,
): Lookup {
  return workspaceRow(
    kind,
    async (db, workspaceId, id, where) =>
      (
        await db
          .select({ name: table.name, createdAt: table.createdAt })
          .from(table)
          .where(
            and(
              eq(table.id, id),
              eq(table.workspaceId, workspaceId),
              // A private bot template is its creator's alone.
              table === schema.botTemplates
                ? or(
                    eq(schema.botTemplates.visibility, "workspace"),
                    eq(schema.botTemplates.createdBySubjectId, where.subjectId),
                  )
                : undefined,
            ),
          )
          .limit(1)
      )[0],
    (row) => ({ kind, name: row.name, facts: facts(["Created", targetDay(row.createdAt)]) }),
  );
}

const documentLookup = workspaceRow(
  "document",
  async (db, workspaceId, id, where) =>
    (
      await db
        .select({
          title: schema.documents.title,
          sourceTitle: schema.documents.sourceTitle,
          base: schema.documentBases.name,
          baseId: schema.documents.baseId,
          createdAt: schema.documents.createdAt,
        })
        .from(schema.documents)
        .leftJoin(schema.documentBases, eq(schema.documentBases.id, schema.documents.baseId))
        .where(
          and(
            eq(schema.documents.id, id),
            eq(schema.documents.workspaceId, workspaceId),
            // A private document is its creator's alone.
            or(
              ne(schema.documents.visibility, "private"),
              eq(schema.documents.createdBy, where.subjectId),
            ),
          ),
        )
        .limit(1)
    )[0],
  (row, where) =>
    where.ids.baseId && where.ids.baseId !== row.baseId
      ? missing("document")
      : {
          kind: "document",
          name: row.title?.trim() || row.sourceTitle?.trim() || "Untitled document",
          facts: facts(["Collection", row.base], ["Added", targetDay(row.createdAt)]),
        },
);

const eventSourceLookup = workspaceRow(
  "event source",
  async (db, workspaceId, id, where) =>
    (
      await db
        .select({ name: schema.eventSources.name, status: schema.eventSources.status })
        .from(schema.eventSources)
        .where(
          and(
            eq(schema.eventSources.id, id),
            eq(schema.eventSources.workspaceId, workspaceId),
            // As eventSourceVisibleTo: shared, unowned, or the person's own.
            or(
              eq(schema.eventSources.visibility, "workspace"),
              isNull(schema.eventSources.ownerSubjectId),
              eq(schema.eventSources.ownerSubjectId, where.subjectId),
            ),
          ),
        )
        .limit(1)
    )[0],
  (row) => ({
    kind: "event source",
    name: row.name,
    facts: facts(["Status", row.status === "active" ? undefined : row.status]),
  }),
);

const serviceAccountLookup = organizationRow(
  "service account",
  ["api_keys:manage", "account:admin"],
  async (db, accountId, id) =>
    (
      await db
        .select({
          name: schema.organizationServiceAccounts.name,
          role: schema.organizationServiceAccounts.role,
        })
        .from(schema.organizationServiceAccounts)
        .where(
          and(
            eq(schema.organizationServiceAccounts.id, id),
            eq(schema.organizationServiceAccounts.accountId, accountId),
            isNull(schema.organizationServiceAccounts.deletedAt),
          ),
        )
        .limit(1)
    )[0],
  (row) => ({
    kind: "service account",
    name: row.name,
    facts: facts(["Role", roleName(row.role)]),
  }),
);

const workspaceCustomModelLookup = workspaceRow(
  "custom model",
  async (db, workspaceId, id) =>
    (
      await db
        .select({
          label: schema.workspaceGatewayCustomModels.label,
          model: schema.workspaceGatewayCustomModels.upstreamModelId,
        })
        .from(schema.workspaceGatewayCustomModels)
        .where(
          and(
            eq(schema.workspaceGatewayCustomModels.id, id),
            eq(schema.workspaceGatewayCustomModels.workspaceId, workspaceId),
            isNull(schema.workspaceGatewayCustomModels.retiredAt),
          ),
        )
        .limit(1)
    )[0],
  (row) => ({
    kind: "custom model",
    name: row.label?.trim() || row.model,
    facts: facts(["Model", row.label?.trim() ? row.model : undefined]),
  }),
);

const organizationCustomModelLookup = organizationRow(
  "custom model",
  ["account:admin"],
  async (db, accountId, id) =>
    (
      await db
        .select({
          label: schema.organizationModelProviderCustomModels.label,
          model: schema.organizationModelProviderCustomModels.upstreamModelId,
        })
        .from(schema.organizationModelProviderCustomModels)
        .where(
          and(
            eq(schema.organizationModelProviderCustomModels.id, id),
            eq(schema.organizationModelProviderCustomModels.accountId, accountId),
            isNull(schema.organizationModelProviderCustomModels.retiredAt),
          ),
        )
        .limit(1)
    )[0],
  (row) => ({
    kind: "custom model",
    name: row.label?.trim() || row.model,
    facts: facts(["Model", row.label?.trim() ? row.model : undefined]),
  }),
);

const SUBSCRIPTION_NAMES: Record<string, string> = {
  codex: "ChatGPT",
  openai: "ChatGPT",
  claude: "Claude",
  anthropic: "Claude",
  supergrok: "SuperGrok",
  xai: "SuperGrok",
};

const subscriptionAccountLookup: Lookup = async (where) => {
  if (!UUID.test(where.id)) return missing("account");
  if (where.organization) ownOrganization(where);
  // Subscription accounts are visible only to a person, in a workspace for workspace routes.
  const asPerson = <T>(run: (db: Database) => Promise<T>) =>
    where.organization
      ? withRlsContext(where.db, { accountId: where.accountId, workspaceId: null }, async (db) => {
          await setSubjectRlsContext(db, where.subjectId);
          return await run(db);
        })
      : inWorkspace(where, async (db) => (await run(db)) ?? null);
  const row = await asPerson(async (db) => {
    const [core] = await db
      .select({
        provider: schema.subscriptionConnections.provider,
        email: schema.subscriptionConnections.accountEmail,
        label: schema.subscriptionConnections.label,
        plan: schema.subscriptionConnections.planType,
        status: schema.subscriptionConnections.status,
      })
      .from(schema.subscriptionConnections)
      .where(
        and(
          eq(schema.subscriptionConnections.id, where.id),
          eq(schema.subscriptionConnections.accountId, where.accountId),
        ),
      )
      .limit(1);
    return core;
  });
  if (!row) return missing("account");
  const product = SUBSCRIPTION_NAMES[row.provider] ?? row.provider;
  return {
    kind: "account",
    name: row.label?.trim() || `${product} account`,
    ...(row.email?.trim() ? { account: row.email.trim() } : {}),
    facts: facts(["Plan", row.plan], ["Status", row.status === "active" ? undefined : row.status]),
  };
};

const githubInstallationLookup: Lookup = async (where) => {
  if (!/^[1-9][0-9]{0,15}$/.test(where.id)) return missing("GitHub installation");
  const row = await inWorkspace(where, async (db, workspaceId) => {
    const [found] = await db
      .select({
        login: schema.githubInstallations.accountLogin,
        type: schema.githubInstallations.accountType,
      })
      .from(schema.githubInstallations)
      .where(
        and(
          sql`${schema.githubInstallations.installationId}::text = ${where.id}`,
          eq(schema.githubInstallations.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return found ?? null;
  });
  return row
    ? {
        kind: "GitHub installation",
        // The id was found in this workspace, so it names the right one.
        name: row.login?.trim() || `Installation ${where.id}`,
        facts: facts(["Type", row.type]),
      }
    : missing("GitHub installation");
};

/** A capability (integration or Skill) by its catalog id, as the workspace sees it. */
function capabilityLookup(kind: string): Lookup {
  return async (where) => {
    const row = await inWorkspace(where, async (db, workspaceId) => {
      const rows = await db
        .select({
          name: schema.capabilityCatalogItems.name,
          accountId: schema.capabilityCatalogItems.accountId,
          workspaceId: schema.capabilityCatalogItems.workspaceId,
        })
        .from(schema.capabilityCatalogItems)
        .where(
          and(
            eq(schema.capabilityCatalogItems.id, where.id),
            or(
              isNull(schema.capabilityCatalogItems.accountId),
              and(
                eq(schema.capabilityCatalogItems.accountId, where.accountId),
                or(
                  isNull(schema.capabilityCatalogItems.workspaceId),
                  eq(schema.capabilityCatalogItems.workspaceId, workspaceId),
                ),
              ),
            ),
          ),
        )
        .limit(3);
      // The workspace's own entry, then the organization's, then the shared one.
      return (
        rows.find((item) => item.workspaceId === workspaceId) ??
        rows.find((item) => item.accountId !== null) ??
        rows[0] ??
        null
      );
    });
    return row ? { kind, name: row.name } : missing(kind);
  };
}

const pluginLookup: Lookup = async (where) => {
  const row = await inWorkspace(where, async (db, workspaceId) => {
    const rows = await db
      .select({
        name: schema.capabilityPlugins.name,
        workspaceId: schema.capabilityPlugins.workspaceId,
      })
      .from(schema.capabilityPlugins)
      .where(
        and(
          eq(schema.capabilityPlugins.pluginKey, where.id),
          or(
            isNull(schema.capabilityPlugins.accountId),
            and(
              eq(schema.capabilityPlugins.accountId, where.accountId),
              or(
                isNull(schema.capabilityPlugins.workspaceId),
                eq(schema.capabilityPlugins.workspaceId, workspaceId),
              ),
            ),
          ),
        ),
      )
      .limit(3);
    return rows.find((item) => item.workspaceId === workspaceId) ?? rows[0] ?? null;
  });
  return row ? { kind: "plugin", name: row.name } : missing("plugin");
};

function interactiveSession(
  kind: string,
  table: typeof schema.browserSessions | typeof schema.computerSessions,
): Lookup {
  return workspaceRow(
    kind,
    async (db, workspaceId, id) =>
      (
        await db
          .select({ name: table.name, createdAt: table.createdAt })
          .from(table)
          .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
          .limit(1)
      )[0],
    (row) => ({
      kind,
      name: row.name?.trim() || `Unnamed ${kind}`,
      facts: facts(["Opened", targetMoment(row.createdAt)]),
    }),
  );
}

/**
 * Lookups by the route words before an id ("connections/:connectionId"), so
 * an id is read only from the table its route names; the route's root comes
 * first where those words mean different tables ("workspaces/members" and
 * "organizations/members"). Ids named the same in every route (workspace,
 * chat, organization) resolve by their parameter.
 */
const LOOKUPS: Record<string, Lookup> = {
  ":workspaceId": workspaceLookup,
  ":sessionId": sessionLookup,
  ":organizationId": organizationLookup,
  "connections/:connectionId": connectionLookup,
  "connections/google-drive/:connectionId": connectionLookup,
  "connections/atlassian/:connectionId": connectionLookup,
  "vault-providers/connections/:connectionId": connectionLookup,
  "social/connections/:connectionId": socialConnectionLookup,
  "organizations/mcp-connections/:connectionId": organizationMcpConnectionLookup,
  "published-artifacts/:artifactId": siteLookup,
  "published-artifacts/:siteId": siteLookup,
  "scheduled-tasks/:taskId": scheduledTaskLookup,
  "scheduled-tasks/private-summaries/:taskId": scheduledTaskLookup,
  "api-keys/:apiKeyId": apiKeyLookup,
  "personal-api-keys/:apiKeyId": apiKeyLookup,
  "workspaces/members/:subjectId": workspaceMemberLookup,
  "organizations/members/:membershipId": organizationMemberLookup,
  "organizations/invitations/:invitationId": invitationLookup,
  "webhooks/:webhookId": webhookLookup,
  "rigs/:rigId": named("rig", schema.rigs),
  "vaults/:vaultId": vaultLookup,
  "items/:itemId": vaultItemLookup,
  "channels/:channelId": named("channel", schema.channels),
  "document-bases/:baseId": named("document collection", schema.documentBases),
  "documents/:documentId": documentLookup,
  "event-sources/:sourceId": eventSourceLookup,
  "bot-templates/:templateId": named("bot template", schema.botTemplates),
  "automation-templates/:templateId": named("automation template", schema.automationTemplates),
  "service-accounts/:serviceAccountId": serviceAccountLookup,
  "workspaces/custom-models/:customModelId": workspaceCustomModelLookup,
  "gateway-custom-models/:customModelId": workspaceCustomModelLookup,
  "openrouter-custom-models/:customModelId": workspaceCustomModelLookup,
  "opper-custom-models/:customModelId": workspaceCustomModelLookup,
  "organizations/custom-models/:customModelId": organizationCustomModelLookup,
  "codex/accounts/:accountId": subscriptionAccountLookup,
  "claude/accounts/:accountId": subscriptionAccountLookup,
  "supergrok/accounts/:accountId": subscriptionAccountLookup,
  "github/installations/:installationId": githubInstallationLookup,
  "integrations/:capabilityId": capabilityLookup("integration"),
  "capabilities/:capabilityId": capabilityLookup("integration"),
  "skills/:capabilityId": capabilityLookup("Skill"),
  "plugins/:pluginKey": pluginLookup,
  "browser-sessions/:browserSessionId": interactiveSession("browser", schema.browserSessions),
  "computer-sessions/:computerSessionId": interactiveSession("computer", schema.computerSessions),
};

const KNOWN_PARENTS = new Set([
  ":workspaceId",
  ":organizationId",
  ":vaultId",
  ":baseId",
  ":providerKind",
]);

/** The lookup for one path id, or undefined when its route has none. */
export function appActionTargetLookupKey(path: string, parameter: string): string | undefined {
  const segments = path.split("/");
  if (LOOKUPS[`:${parameter}`]) return `:${parameter}`;
  const index = segments.indexOf(`:${parameter}`);
  if (index < 0) return undefined;
  const words: string[] = [];
  let at = index - 1;
  for (; at >= 0 && !segments[at]!.startsWith(":"); at -= 1) words.unshift(segments[at]!);
  // Under another resource's id the same words can mean another table (a
  // realtime call's "connections"); only parents whose children are known.
  if (at >= 0 && !KNOWN_PARENTS.has(segments[at]!)) return undefined;
  const key = `${words.join("/")}/:${parameter}`;
  const rooted = `${segments[2]}/${key}`;
  return LOOKUPS[rooted] ? rooted : LOOKUPS[key] ? key : undefined;
}

function lookupFor(segments: string[], parameter: string): Lookup | undefined {
  const key = appActionTargetLookupKey(segments.join("/"), parameter);
  return key ? LOOKUPS[key] : undefined;
}

/**
 * The wording an app action's approval was first saved with, so a resumed
 * attempt asks it the same way instead of reading its targets again (the
 * saved review keeps its first context).
 */
export async function savedAppActionApprovalCard(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    approvalId: string;
  },
): Promise<{ title: string; targetFacts: Fact[] } | undefined> {
  const scope = { accountId: input.accountId, workspaceId: input.workspaceId };
  const row = await withRlsContext(db, scope, async (scoped) => {
    const [found] = await scoped
      .select({ reviewContext: schema.connectorActionRequests.reviewContext })
      .from(schema.connectorActionRequests)
      .where(
        and(
          eq(schema.connectorActionRequests.accountId, input.accountId),
          eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
          eq(schema.connectorActionRequests.sessionId, input.sessionId),
          eq(schema.connectorActionRequests.turnId, input.turnId),
          eq(schema.connectorActionRequests.approvalId, input.approvalId),
        ),
      )
      .limit(1);
    return found;
  });
  const context = row?.reviewContext;
  const title = typeof context?.title === "string" ? context.title.trim() : "";
  if (!title) return undefined;
  return { title, targetFacts: context?.targetFacts ?? [] };
}
