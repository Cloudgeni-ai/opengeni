import { MAX_SESSION_ADMIN_ACCESS_HOURS, Permission } from "@opengeni/contracts";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { nestedPostgresSqlState } from "./persistence-errors";
import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import * as schema from "./schema";
import { subjectHasLiveWorkspaceAuthorityInScope } from "./workspace-authority";

/**
 * Full access for agent sessions (migration 0691; stored as "admin access").
 * An organization allows it (off by default); any member then gives a session
 * they started themselves their own access for a number of hours or with no
 * time limit, and the agent there can do what that person can do, never more:
 * every action it runs is checked against the person's live access. Every use
 * goes through {@link resolveSessionAdminAuthority}, which re-checks the
 * allowance, the grant, its time limit and that the person still belongs to
 * the session's workspace.
 */
export type OrganizationAgentAdminAccess = {
  sessionAdminAccessAllowed: boolean;
  /** In-chat app actions, each change confirmed by the person (0971). On unless turned off. */
  chatActionsAllowed: boolean;
  updatedAt: string | null;
};

export type SessionAdminAccessGrant = {
  sessionId: string;
  grantedBySubjectId: string;
  grantedAt: string;
  /** When it ends by itself; null means no time limit. */
  expiresAt: string | null;
};

/** Raised when the organization does not allow admin access for sessions. */
export class SessionAdminAccessNotAllowedError extends Error {
  constructor() {
    super("This organization doesn't allow full access for agent sessions");
    this.name = "SessionAdminAccessNotAllowedError";
  }
}

/** Raised when the person no longer belongs to the session's workspace. */
export class SessionAdminAccessNotWorkspaceMemberError extends Error {
  constructor() {
    super("Only someone who can use this workspace can give a session their access");
    this.name = "SessionAdminAccessNotWorkspaceMemberError";
  }
}

/**
 * Raised when the session isn't the person's own: only a session someone
 * started themselves can be given their access, so nobody else's agent ever
 * acts as them.
 */
export class SessionAdminAccessNotOwnSessionError extends Error {
  constructor() {
    super("Only a session you started yourself can be given your access");
    this.name = "SessionAdminAccessNotOwnSessionError";
  }
}

async function readAllowance(scopedDb: Database, accountId: string, lock = false) {
  const query = scopedDb
    .select()
    .from(schema.organizationAgentAdminAccess)
    .where(eq(schema.organizationAgentAdminAccess.accountId, accountId))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return {
    sessionAdminAccessAllowed: row?.sessionAdminAccessAllowed ?? false,
    chatActionsAllowed: row?.chatActionsAllowed ?? true,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  } satisfies OrganizationAgentAdminAccess;
}

/** Raises 42501 unless `subjectId` is an active owner or admin of the organization. */
async function assertOrganizationAdministrator(
  scopedDb: Database,
  organizationId: string,
  subjectId: string,
): Promise<void> {
  await setSubjectRlsContext(scopedDb, subjectId);
  await scopedDb.execute(sql`
    select get_organization_administration_overview(${organizationId}::uuid, ${subjectId})
  `);
}

/**
 * Whether `subjectId` can give a session in `workspaceId` their access, and
 * whether a grant they gave still holds: they still belong to the workspace
 * (live), or they are an active owner or admin of the organization. Runs in
 * its own savepoint so a refused administrator check never aborts the caller.
 */
async function canActInWorkspace(
  scopedDb: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  return await scopedDb.transaction(async (nested) => {
    await setSubjectRlsContext(nested, input.subjectId);
    if (await subjectHasLiveWorkspaceAuthorityInScope(nested, input)) return true;
    try {
      await nested.transaction(async (inner) => {
        await assertOrganizationAdministrator(inner, input.accountId, input.subjectId);
      });
      return true;
    } catch (error) {
      if (nestedPostgresSqlState(error) === "42501") return false;
      throw error;
    }
  });
}

function mapGrant(row: typeof schema.sessionAdminAccess.$inferSelect): SessionAdminAccessGrant {
  return {
    sessionId: row.sessionId,
    grantedBySubjectId: row.grantedBySubjectId,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** A grant still in effect: no time limit, or one not yet reached (database clock). */
const grantNotExpired = or(
  isNull(schema.sessionAdminAccess.expiresAt),
  gt(schema.sessionAdminAccess.expiresAt, sql`now()`),
);

/** The organization's agent choices. Absent reads as full access off, in-chat actions on. */
export async function getOrganizationAgentAdminAccess(
  db: Database,
  accountId: string,
): Promise<OrganizationAgentAdminAccess> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (scopedDb) =>
    readAllowance(scopedDb, accountId),
  );
}

/**
 * Allow or stop full access for sessions, in-chat app actions, or both; an
 * omitted choice stays as it is. Only an owner or admin may change them.
 * Turning full access off also removes every session's full access, so
 * turning it on again never silently restores old grants.
 */
export async function setOrganizationAgentAdminAccess(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    sessionAdminAccessAllowed?: boolean | undefined;
    chatActionsAllowed?: boolean | undefined;
  },
): Promise<OrganizationAgentAdminAccess> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await assertOrganizationAdministrator(scopedDb, input.organizationId, input.actorSubjectId);
      const changes = {
        ...(input.sessionAdminAccessAllowed !== undefined
          ? { sessionAdminAccessAllowed: input.sessionAdminAccessAllowed }
          : {}),
        ...(input.chatActionsAllowed !== undefined
          ? { chatActionsAllowed: input.chatActionsAllowed }
          : {}),
      };
      await scopedDb
        .insert(schema.organizationAgentAdminAccess)
        .values({
          accountId: input.organizationId,
          ...changes,
          updatedBySubjectId: input.actorSubjectId,
        })
        .onConflictDoUpdate({
          target: schema.organizationAgentAdminAccess.accountId,
          set: {
            ...changes,
            updatedBySubjectId: input.actorSubjectId,
            updatedAt: new Date(),
          },
        });
      if (input.sessionAdminAccessAllowed === false) {
        await scopedDb
          .delete(schema.sessionAdminAccess)
          .where(eq(schema.sessionAdminAccess.accountId, input.organizationId));
      }
      return await readAllowance(scopedDb, input.organizationId);
    },
  );
}

/** The session's admin access as recorded; null when it has none. */
export async function getSessionAdminAccess(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<SessionAdminAccessGrant | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: null },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.sessionAdminAccess)
        .where(
          and(
            eq(schema.sessionAdminAccess.sessionId, input.sessionId),
            eq(schema.sessionAdminAccess.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      return row ? mapGrant(row) : null;
    },
  );
}

/**
 * Give a session admin access as `actorSubjectId`, who must belong to the
 * session's workspace (or be an active owner or admin), in an organization
 * that allows it, on a session they started themselves, for `durationHours` hours or, when null, with no time limit.
 * Giving it again while it is on sets a new time limit from now; after it
 * ended by itself, it counts as given anew.
 */
export async function grantSessionAdminAccess(
  db: Database,
  input: {
    organizationId: string;
    workspaceId: string;
    sessionId: string;
    actorSubjectId: string;
    durationHours: number | null;
  },
): Promise<SessionAdminAccessGrant> {
  const hours = input.durationHours;
  if (
    hours !== null &&
    (!Number.isInteger(hours) || hours < 1 || hours > MAX_SESSION_ADMIN_ACCESS_HOURS)
  ) {
    throw new RangeError(
      `Admin access lasts 1 to ${MAX_SESSION_ADMIN_ACCESS_HOURS} hours, or has no time limit`,
    );
  }
  const expiresAt = hours === null ? null : sql`now() + make_interval(hours => ${hours}::int)`;
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      if (
        !(await canActInWorkspace(scopedDb, {
          accountId: input.organizationId,
          workspaceId: input.workspaceId,
          subjectId: input.actorSubjectId,
        }))
      ) {
        throw new SessionAdminAccessNotWorkspaceMemberError();
      }
      const allowance = await readAllowance(scopedDb, input.organizationId, true);
      if (!allowance.sessionAdminAccessAllowed) throw new SessionAdminAccessNotAllowedError();
      const [own] = await scopedDb
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, input.sessionId),
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.accountId, input.organizationId),
            eq(schema.sessions.createdByKind, "subject"),
            eq(schema.sessions.createdBySubjectId, input.actorSubjectId),
          ),
        )
        .limit(1);
      if (!own) throw new SessionAdminAccessNotOwnSessionError();
      const [row] = await scopedDb
        .insert(schema.sessionAdminAccess)
        .values({
          sessionId: input.sessionId,
          accountId: input.organizationId,
          workspaceId: input.workspaceId,
          grantedBySubjectId: input.actorSubjectId,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: schema.sessionAdminAccess.sessionId,
          set: {
            expiresAt,
            grantedBySubjectId: input.actorSubjectId,
            grantedAt: sql`case
              when ${schema.sessionAdminAccess.expiresAt} is not null
                and ${schema.sessionAdminAccess.expiresAt} <= now()
              then now()
              else ${schema.sessionAdminAccess.grantedAt}
            end`,
          },
        })
        .returning();
      if (!row) throw new Error("session admin access could not be recorded");
      return mapGrant(row);
    },
  );
}

/** End a session's admin access. Returns whether it had any. */
export async function revokeSessionAdminAccess(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: null },
    async (scopedDb) => {
      const removed = await scopedDb
        .delete(schema.sessionAdminAccess)
        .where(
          and(
            eq(schema.sessionAdminAccess.sessionId, input.sessionId),
            eq(schema.sessionAdminAccess.workspaceId, input.workspaceId),
          ),
        )
        .returning({ sessionId: schema.sessionAdminAccess.sessionId });
      return removed.length > 0;
    },
  );
}

/**
 * The person whose access this session uses right now, or null. Live on every
 * call: the organization must still allow it, the grant must still exist and
 * be within its time limit, and the person who gave it must still belong to
 * the session's workspace (or be an active owner or admin).
 */
export async function resolveSessionAdminAuthority(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<{ subjectId: string; grantedAt: string; expiresAt: string | null } | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: null },
    async (scopedDb) => {
      const allowance = await readAllowance(scopedDb, input.accountId);
      if (!allowance.sessionAdminAccessAllowed) return null;
      const [row] = await scopedDb
        .select()
        .from(schema.sessionAdminAccess)
        .where(
          and(
            eq(schema.sessionAdminAccess.sessionId, input.sessionId),
            eq(schema.sessionAdminAccess.workspaceId, input.workspaceId),
            grantNotExpired,
          ),
        )
        .limit(1);
      if (!row) return null;
      if (
        !(await canActInWorkspace(scopedDb, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: row.grantedBySubjectId,
        }))
      ) {
        return null;
      }
      return {
        subjectId: row.grantedBySubjectId,
        grantedAt: row.grantedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
      };
    },
  );
}

/**
 * What a viewer needs to show and change a session's admin access: whether
 * the organization allows it, the grant while it is within its time limit,
 * whether it is in effect right now, whether the viewer started this
 * session, and whether they are an owner or admin (who may end anyone's).
 */
export async function getSessionAdminAccessView(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; viewerSubjectId: string },
): Promise<{
  allowed: boolean;
  grant: SessionAdminAccessGrant | null;
  active: boolean;
  viewerStartedSession: boolean;
  viewerIsAdministrator: boolean;
}> {
  const [authority, details] = await Promise.all([
    resolveSessionAdminAuthority(db, input),
    withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (scopedDb) => {
        const allowance = await readAllowance(scopedDb, input.accountId);
        const [grantRow] = await scopedDb
          .select()
          .from(schema.sessionAdminAccess)
          .where(
            and(
              eq(schema.sessionAdminAccess.sessionId, input.sessionId),
              eq(schema.sessionAdminAccess.workspaceId, input.workspaceId),
              grantNotExpired,
            ),
          )
          .limit(1);
        const [session] = await scopedDb
          .select({
            createdByKind: schema.sessions.createdByKind,
            createdBySubjectId: schema.sessions.createdBySubjectId,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.workspaceId, input.workspaceId),
            ),
          )
          .limit(1);
        let viewerIsAdministrator = true;
        try {
          await scopedDb.transaction(async (nested) => {
            await assertOrganizationAdministrator(nested, input.accountId, input.viewerSubjectId);
          });
        } catch (error) {
          if (nestedPostgresSqlState(error) !== "42501") throw error;
          viewerIsAdministrator = false;
        }
        return {
          allowed: allowance.sessionAdminAccessAllowed,
          grant: grantRow ? mapGrant(grantRow) : null,
          viewerStartedSession:
            session?.createdByKind === "subject" &&
            session.createdBySubjectId === input.viewerSubjectId,
          viewerIsAdministrator,
        };
      },
    ),
  ]);
  return { ...details, active: authority !== null };
}

/**
 * Whether a session lists the app-action tools: it is one a person started
 * themselves (not a child or service session). Fixed for the session's life,
 * so its tool list never changes because of it.
 */
export async function sessionStartedByPerson(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [session] = await scopedDb
        .select({
          createdByKind: schema.sessions.createdByKind,
          parentSessionId: schema.sessions.parentSessionId,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, input.sessionId),
            eq(schema.sessions.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      return session?.createdByKind === "subject" && session.parentSessionId === null;
    },
  );
}

/** Why an app action can't run as anyone in this turn. */
export type SessionAppActionUnavailableReason =
  | "organization_off"
  | "not_person_session"
  | "no_person_present"
  | "not_signed_in_person"
  | "not_member";

/**
 * What one turn's message may do through app actions, frozen when the message
 * is accepted and never changed: who sent it, whether they can confirm changes
 * from where they sent it, and the most it may do (their own access then).
 */
export type TurnAppActionGrant = {
  subjectId: string;
  /**
   * `confirm`: each change runs after this person confirms it in the chat
   * (signed in to the app itself, or an embed whose host opted in).
   * `none`: reads only (any other embed or integration).
   */
  changes: "confirm" | "none";
  permissions: readonly Permission[];
};

/** Record a turn's frozen app-action grant, inside the transaction that accepts its message. */
export async function recordTurnAppActionGrant(
  tx: Database,
  input: { accountId: string; workspaceId: string; turnId: string; grant: TurnAppActionGrant },
): Promise<void> {
  await tx
    .insert(schema.sessionTurnAppActionGrants)
    .values({
      turnId: input.turnId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.grant.subjectId,
      changes: input.grant.changes,
      permissions: [...new Set(input.grant.permissions)],
    })
    .onConflictDoNothing({ target: schema.sessionTurnAppActionGrants.turnId });
}

/**
 * What one person's sign-in could do in this workspace when they last sent a
 * message to this chat (the frozen grants above, whatever the organization
 * allows through app actions): the same effective access their chat shows,
 * narrowed by an embed's token and including their own workspace. This
 * turn's own grant when they sent its message; otherwise, for a turn the
 * platform started for them (a wake-up, a child's result, a goal
 * continuation), their latest message's grant in the same chat. `null` when
 * they never sent one here.
 */
export async function readTurnSenderAccess(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    subjectId: string;
  },
): Promise<{ permissions: Permission[] } | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const grants = schema.sessionTurnAppActionGrants;
      const [frozen] = await scopedDb
        .select({ permissions: grants.permissions })
        .from(grants)
        .innerJoin(schema.sessionTurns, eq(schema.sessionTurns.id, grants.turnId))
        .where(
          and(
            eq(grants.workspaceId, input.workspaceId),
            eq(grants.subjectId, input.subjectId),
            eq(schema.sessionTurns.workspaceId, input.workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
          ),
        )
        // This turn's own grant first, then the latest message's.
        .orderBy(sql`${grants.turnId} = ${input.turnId} desc`, desc(grants.createdAt))
        .limit(1);
      if (!frozen) return null;
      return {
        permissions: frozen.permissions.flatMap((value) => {
          const parsed = Permission.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        }),
      };
    },
  );
}

/**
 * As whom an app action in this turn runs, checked live on every call:
 *
 * - `full_access`: the session has full access; the person who gave it, with
 *   everything they can do, no confirmation (unchanged).
 * - `confirm`: the person who sent this turn's message, in a session a person
 *   started, in an organization that allows in-chat actions, from where they
 *   can confirm (see {@link TurnAppActionGrant}). Reads run; each change runs
 *   only after that same person confirms it in the chat.
 * - `read_only`: the same, from an embed or integration that can't confirm
 *   changes; reads run, changes never do.
 * - `unavailable`: nobody; scheduled, goal and other unattended turns, child
 *   and service sessions gain nothing.
 *
 * `confirm` and `read_only` carry the turn's frozen permissions: an action
 * never runs with more than the sender's own access when they sent it, and
 * each route still checks their live access.
 */
export async function resolveSessionAppActionAuthority(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<
  | { kind: "full_access"; subjectId: string }
  | { kind: "confirm" | "read_only"; subjectId: string; permissions: Permission[] }
  | { kind: "unavailable"; reason: SessionAppActionUnavailableReason }
> {
  const full = await resolveSessionAdminAuthority(db, input);
  if (full) return { kind: "full_access", subjectId: full.subjectId };
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const allowance = await readAllowance(scopedDb, input.accountId);
      if (!allowance.chatActionsAllowed) {
        return { kind: "unavailable", reason: "organization_off" } as const;
      }
      const [row] = await scopedDb
        .select({
          createdByKind: schema.sessions.createdByKind,
          parentSessionId: schema.sessions.parentSessionId,
          source: schema.sessionTurns.source,
          initiatorKind: schema.sessionTurns.initiatorKind,
          initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
        })
        .from(schema.sessionTurns)
        .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionTurns.sessionId))
        .where(
          and(
            eq(schema.sessionTurns.id, input.turnId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessions.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      if (!row || row.createdByKind !== "subject" || row.parentSessionId !== null) {
        return { kind: "unavailable", reason: "not_person_session" } as const;
      }
      // Only a message a person sent; schedules, goals, inbox and other
      // continuations run with nobody there to confirm anything.
      if (row.initiatorKind !== "subject" || (row.source !== "user" && row.source !== "api")) {
        return { kind: "unavailable", reason: "no_person_present" } as const;
      }
      const [frozen] = await scopedDb
        .select({
          subjectId: schema.sessionTurnAppActionGrants.subjectId,
          changes: schema.sessionTurnAppActionGrants.changes,
          permissions: schema.sessionTurnAppActionGrants.permissions,
        })
        .from(schema.sessionTurnAppActionGrants)
        .where(
          and(
            eq(schema.sessionTurnAppActionGrants.turnId, input.turnId),
            eq(schema.sessionTurnAppActionGrants.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      // No frozen grant: an API key, a service, or a message accepted before
      // this existed. Nobody signed in to act for.
      if (!frozen || frozen.subjectId !== row.initiatorSubjectId) {
        return { kind: "unavailable", reason: "not_signed_in_person" } as const;
      }
      if (
        !(await canActInWorkspace(scopedDb, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: row.initiatorSubjectId,
        }))
      ) {
        return { kind: "unavailable", reason: "not_member" } as const;
      }
      return {
        kind: frozen.changes === "confirm" ? "confirm" : "read_only",
        subjectId: row.initiatorSubjectId,
        permissions: frozen.permissions.flatMap((value) => {
          const parsed = Permission.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        }),
      } as const;
    },
  );
}

/**
 * The saved arguments of app-action changes `subjectId` confirmed in the chat
 * that this attempt is running right now: approved by that person while signed
 * in where a change may be confirmed (the app itself, or an embed the
 * deployment opted in), and marked as executing by this exact attempt. An
 * Allow sent with a key, a chat integration button or another token carrying
 * the same identity confirms nothing. The API runs a change without full access
 * only when its arguments are one of these.
 */
export async function listConfirmedAppActionChanges(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    subjectId: string;
    toolName: string;
  },
): Promise<string[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select({ reviewArguments: schema.connectorActionRequests.reviewArguments })
        .from(schema.connectorActionRequests)
        .where(
          and(
            eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
            eq(schema.connectorActionRequests.sessionId, input.sessionId),
            eq(schema.connectorActionRequests.turnId, input.turnId),
            eq(schema.connectorActionRequests.executionAttemptId, input.attemptId),
            eq(schema.connectorActionRequests.serverId, "opengeni"),
            eq(schema.connectorActionRequests.toolName, input.toolName),
            eq(schema.connectorActionRequests.status, "executing"),
            eq(schema.connectorActionRequests.decision, "approve"),
            eq(schema.connectorActionRequests.decisionBySubjectId, input.subjectId),
            eq(schema.connectorActionRequests.decisionByKind, "human"),
            eq(schema.connectorActionRequests.decisionBySignedInPerson, true),
          ),
        );
      return rows.flatMap((row) => (row.reviewArguments === null ? [] : [row.reviewArguments]));
    },
  );
}
