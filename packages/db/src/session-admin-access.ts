import { MAX_SESSION_ADMIN_ACCESS_HOURS } from "@opengeni/contracts";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

import { nestedPostgresSqlState } from "./persistence-errors";
import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import * as schema from "./schema";

/**
 * Admin access for agent sessions (migration 0691). An organization allows it
 * (off by default); an owner or admin then gives one of their sessions admin
 * access for a number of hours or with no time limit, and the agent there can
 * do what that person can manage. Every use goes through
 * {@link resolveSessionAdminAuthority}, which re-checks the allowance, the
 * grant, its time limit and the person's live role.
 */
export type OrganizationAgentAdminAccess = {
  sessionAdminAccessAllowed: boolean;
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
    super("This organization doesn't allow admin access for agent sessions");
    this.name = "SessionAdminAccessNotAllowedError";
  }
}

/**
 * Raised when the session isn't the person's own: only a session someone
 * started themselves can be given their access, so nobody else's agent ever
 * acts as them.
 */
export class SessionAdminAccessNotOwnSessionError extends Error {
  constructor() {
    super("Only a session you started yourself can be given your admin access");
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

/** Whether owners and admins may give sessions admin access. Absent reads as off. */
export async function getOrganizationAgentAdminAccess(
  db: Database,
  accountId: string,
): Promise<OrganizationAgentAdminAccess> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (scopedDb) =>
    readAllowance(scopedDb, accountId),
  );
}

/**
 * Allow or stop admin access for sessions. Only an owner or admin may change
 * it. Turning it off also removes every session's admin access, so turning it
 * on again never silently restores old grants.
 */
export async function setOrganizationAgentAdminAccess(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; sessionAdminAccessAllowed: boolean },
): Promise<OrganizationAgentAdminAccess> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await assertOrganizationAdministrator(scopedDb, input.organizationId, input.actorSubjectId);
      await scopedDb
        .insert(schema.organizationAgentAdminAccess)
        .values({
          accountId: input.organizationId,
          sessionAdminAccessAllowed: input.sessionAdminAccessAllowed,
          updatedBySubjectId: input.actorSubjectId,
        })
        .onConflictDoUpdate({
          target: schema.organizationAgentAdminAccess.accountId,
          set: {
            sessionAdminAccessAllowed: input.sessionAdminAccessAllowed,
            updatedBySubjectId: input.actorSubjectId,
            updatedAt: new Date(),
          },
        });
      if (!input.sessionAdminAccessAllowed) {
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
 * Give a session admin access as `actorSubjectId`, who must be an active owner
 * or admin, in an organization that allows it, on a session they started
 * themselves, for `durationHours` hours or, when null, with no time limit.
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
      await assertOrganizationAdministrator(scopedDb, input.organizationId, input.actorSubjectId);
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
 * be within its time limit, and the person who gave it must still be an
 * active owner or admin.
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
      try {
        await scopedDb.transaction(async (nested) => {
          await assertOrganizationAdministrator(nested, input.accountId, row.grantedBySubjectId);
        });
      } catch (error) {
        if (nestedPostgresSqlState(error) === "42501") return null;
        throw error;
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
 * whether it is in effect right now, and whether the viewer started this
 * session and is an owner or admin themselves.
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
