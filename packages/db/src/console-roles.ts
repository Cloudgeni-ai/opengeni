/**
 * Console roles of organization members (`organization_console_roles`,
 * migration 1508). Owners and admins are always full in Console and have no
 * row; a member's role is `none` (no row), `viewer` or `editor`. A row names a
 * member by their `user:` subject, or a pending invitation whose role becomes
 * the member's when they accept it.
 *
 * Authorization lives in the API (`apps/api/src/routes/console-roles.ts`):
 * only an organization owner or admin, signed in as themselves, writes these
 * rows, and the API resolves a reader's role before every Console read. Every
 * change is written to the Console audit log in the same transaction.
 */
import type { ConsoleMemberRole, ConsoleMemberRoleEntry, Permission } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { insertConsoleAuditEvent } from "./console";
import { rawRows, withAccountRls, withWorkspaceRls, type Database } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import { grantWorkspaceAccess } from "./workspace-membership-access";

export type ConsoleRoleTarget = { subjectId: string } | { invitationId: string };

/**
 * Serializes every Console role write for one person (or invitation) in an
 * organization: setting a role, clearing it after an organization role change
 * or offboarding, and applying an accepted invitation's role. A role write
 * that checks the person's membership does so after taking this lock, so a
 * concurrent offboarding that clears the role either finishes first (and the
 * check refuses) or clears it after.
 */
export async function lockConsoleRoleTarget(
  tx: Database,
  accountId: string,
  target: ConsoleRoleTarget,
): Promise<void> {
  const key =
    "subjectId" in target
      ? `console-role:${accountId}:subject:${target.subjectId}`
      : `console-role:${accountId}:invitation:${target.invitationId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** The named invitation is not in this organization. */
export class ConsoleRoleTargetNotFoundError extends Error {
  constructor() {
    super("invitation not found");
    this.name = "ConsoleRoleTargetNotFoundError";
  }
}

type RoleRow = {
  subject_id: string | null;
  invitation_id: string | null;
  role: ConsoleMemberRole;
  updated_by_subject_id: string;
  updated_at: Date | string;
};

function entry(row: RoleRow): ConsoleMemberRoleEntry {
  return {
    subjectId: row.subject_id,
    invitationId: row.invitation_id,
    role: row.role,
    updatedBySubjectId: row.updated_by_subject_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizedRole(value: unknown): ConsoleMemberRole {
  return value === "viewer" || value === "editor" ? value : "none";
}

/** A member's Console role in the organization; `none` without a row. */
export async function getConsoleMemberRole(
  db: Database,
  accountId: string,
  subjectId: string,
): Promise<ConsoleMemberRole> {
  const [row] = await withAccountRls(db, accountId, (tx) =>
    rawRows<{ role: string }>(
      tx,
      sql`select role from organization_console_roles
        where account_id = ${accountId}::uuid and subject_id = ${subjectId}`,
    ),
  );
  return normalizedRole(row?.role);
}

/** Every Console role set in the organization (members and pending invitations). */
export async function listConsoleMemberRoles(
  db: Database,
  accountId: string,
): Promise<ConsoleMemberRoleEntry[]> {
  const rows = await withAccountRls(db, accountId, (tx) =>
    rawRows<RoleRow>(
      tx,
      sql`select subject_id, invitation_id::text as invitation_id, role,
          updated_by_subject_id, updated_at
        from organization_console_roles
        where account_id = ${accountId}::uuid and role <> 'none'
          and (invitation_id is null or applied_at is null)
        order by created_at, id`,
    ),
  );
  return rows.map((row) => ({ ...entry(row), role: normalizedRole(row.role) }));
}

async function upsertRole(
  tx: Database,
  input: {
    accountId: string;
    target: ConsoleRoleTarget;
    role: ConsoleMemberRole;
    actorSubjectId: string;
    actorLabel: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<{ entry: ConsoleMemberRoleEntry; from: ConsoleMemberRole; changed: boolean }> {
  await lockConsoleRoleTarget(tx, input.accountId, input.target);
  const bySubject = "subjectId" in input.target;
  const subjectId = "subjectId" in input.target ? input.target.subjectId : null;
  const invitationId = "invitationId" in input.target ? input.target.invitationId : null;
  const [previous] = await rawRows<{ role: string }>(
    tx,
    bySubject
      ? sql`select role from organization_console_roles
          where account_id = ${input.accountId}::uuid and subject_id = ${subjectId} for update`
      : sql`select role from organization_console_roles
          where account_id = ${input.accountId}::uuid and invitation_id = ${invitationId}::uuid
          for update`,
  );
  const from = normalizedRole(previous?.role);
  const actor = input.actorSubjectId.slice(0, 1024);
  let rows: RoleRow[];
  try {
    rows = await rawRows<RoleRow>(
      tx,
      bySubject
        ? sql`insert into organization_console_roles
              (account_id, subject_id, role, updated_by_subject_id, updated_at)
            values (${input.accountId}::uuid, ${subjectId}, ${input.role}, ${actor}, now())
            on conflict on constraint organization_console_roles_subject_uq do update
              set role = excluded.role, updated_by_subject_id = excluded.updated_by_subject_id,
                updated_at = excluded.updated_at
            returning subject_id, invitation_id::text as invitation_id, role,
              updated_by_subject_id, updated_at`
        : sql`insert into organization_console_roles
              (account_id, invitation_id, role, updated_by_subject_id, updated_at)
            values (${input.accountId}::uuid, ${invitationId}::uuid, ${input.role}, ${actor}, now())
            on conflict on constraint organization_console_roles_invitation_uq do update
              set role = excluded.role, updated_by_subject_id = excluded.updated_by_subject_id,
                updated_at = excluded.updated_at
            returning subject_id, invitation_id::text as invitation_id, role,
              updated_by_subject_id, updated_at`,
    );
  } catch (error) {
    // 23503: the invitation is not this organization's (or does not exist).
    if (nestedPostgresSqlState(error) === "23503") throw new ConsoleRoleTargetNotFoundError();
    throw error;
  }
  const changed = from !== input.role;
  if (changed) {
    await insertConsoleAuditEvent(tx, {
      accountId: input.accountId,
      actorSubjectId: input.actorSubjectId,
      actorLabel: input.actorLabel,
      action: "member.console_role_changed",
      workspaceId: null,
      sessionId: null,
      detail: {
        ...(subjectId ? { subjectId } : {}),
        ...(invitationId ? { invitationId } : {}),
        from,
        to: input.role,
        ...input.detail,
      },
    });
  }
  return { entry: entry(rows[0]!), from, changed };
}

/**
 * Sets a member's or pending invitation's Console role and audits the change
 * (an unchanged role writes no audit row). The caller checked that the actor
 * administers the organization. `verifyTarget` runs in the same transaction,
 * after the target's lock: it checks the person is still a member (or the
 * invitation still pending), so a concurrent offboarding can't be overtaken.
 */
export async function setConsoleMemberRole(
  db: Database,
  input: {
    accountId: string;
    target: ConsoleRoleTarget;
    role: ConsoleMemberRole;
    actorSubjectId: string;
    actorLabel: string | null;
    reason?: string;
    verifyTarget?: (tx: Database) => Promise<void>;
  },
): Promise<{ entry: ConsoleMemberRoleEntry; from: ConsoleMemberRole; changed: boolean }> {
  const { verifyTarget, reason, ...rest } = input;
  return await withAccountRls(db, input.accountId, async (tx) => {
    await lockConsoleRoleTarget(tx, input.accountId, input.target);
    await verifyTarget?.(tx);
    return await upsertRole(tx, { ...rest, ...(reason ? { detail: { reason } } : {}) });
  });
}

/**
 * Clears a member's Console role (to `none`) when they had one, for example
 * when they leave the organization or their organization role changes.
 * Returns the role they had.
 */
export async function clearConsoleMemberRole(
  db: Database,
  input: {
    accountId: string;
    subjectId: string;
    actorSubjectId: string;
    actorLabel: string | null;
    reason: string;
  },
): Promise<ConsoleMemberRole> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    await lockConsoleRoleTarget(tx, input.accountId, { subjectId: input.subjectId });
    const [row] = await rawRows<{ role: string }>(
      tx,
      sql`select role from organization_console_roles
        where account_id = ${input.accountId}::uuid and subject_id = ${input.subjectId}
        for update`,
    );
    const from = normalizedRole(row?.role);
    if (from === "none") return from;
    await upsertRole(tx, {
      accountId: input.accountId,
      target: { subjectId: input.subjectId },
      role: "none",
      actorSubjectId: input.actorSubjectId,
      actorLabel: input.actorLabel,
      detail: { reason: input.reason },
    });
    return from;
  });
}

/**
 * When a person accepts an invitation, their Console role becomes the one it
 * carried, or none when it carried none (so a role left from an earlier
 * membership never comes back). Once per invitation: the invitation's row is
 * marked applied (a row with role none is written for an invitation that had
 * none), and a replayed acceptance never overwrites a role an admin set
 * later. Runs in the acceptance's transaction. Returns the role applied, or
 * null when it was already applied.
 */
export async function applyInvitationConsoleRole(
  db: Database,
  input: { accountId: string; invitationId: string; subjectId: string },
): Promise<ConsoleMemberRole | null> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    await lockConsoleRoleTarget(tx, input.accountId, { invitationId: input.invitationId });
    const [invitation] = await rawRows<{
      role: string;
      updated_by_subject_id: string;
      applied: boolean;
    }>(
      tx,
      sql`select role, updated_by_subject_id, applied_at is not null as applied
        from organization_console_roles
        where account_id = ${input.accountId}::uuid
          and invitation_id = ${input.invitationId}::uuid
        for update`,
    );
    if (invitation?.applied) return null;
    if (invitation) {
      await rawRows(
        tx,
        sql`update organization_console_roles set applied_at = now()
          where account_id = ${input.accountId}::uuid
            and invitation_id = ${input.invitationId}::uuid`,
      );
    } else {
      await rawRows(
        tx,
        sql`insert into organization_console_roles
            (account_id, invitation_id, role, applied_at, updated_by_subject_id, updated_at)
          values (${input.accountId}::uuid, ${input.invitationId}::uuid, 'none', now(),
            ${input.subjectId.slice(0, 1024)}, now())`,
      );
    }
    const role = normalizedRole(invitation?.role);
    await upsertRole(tx, {
      accountId: input.accountId,
      target: { subjectId: input.subjectId },
      role,
      actorSubjectId: invitation?.updated_by_subject_id ?? input.subjectId,
      actorLabel: null,
      detail: { invitationId: input.invitationId, reason: "invitation_accepted" },
    });
    return role;
  });
}

/**
 * Gives a person Console test chat access: membership of the organization's
 * Console test workspace (`organization_managed_workspaces.source =
 * 'console_test'`) with exactly `permissions`, narrowing a broader row. Every
 * membership there is Console-granted: the workspace exists only for Console
 * test chats. A new or changed membership is audit-logged
 * (`member.console_test_access_granted`); an unchanged one writes nothing.
 */
export async function grantConsoleTestWorkspaceAccess(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    subjectLabel: string | null;
    permissions: readonly Permission[];
  },
): Promise<{ changed: boolean }> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [existing] = await rawRows<{ role: string; permissions: string[] }>(
      tx,
      sql`select role, permissions from workspace_memberships
        where workspace_id = ${input.workspaceId}::uuid and subject_id = ${input.subjectId}
        for update`,
    );
    const wanted = [...input.permissions].sort();
    const held = existing ? [...existing.permissions].sort() : null;
    const same =
      existing?.role === "member" &&
      held !== null &&
      held.length === wanted.length &&
      held.every((permission, index) => permission === wanted[index]);
    if (same) return { changed: false };
    await grantWorkspaceAccess(tx, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      role: "member",
      permissions: [...input.permissions],
      ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
    });
    await withAccountRls(tx, input.accountId, (accountTx) =>
      insertConsoleAuditEvent(accountTx, {
        accountId: input.accountId,
        actorSubjectId: input.subjectId,
        actorLabel: input.subjectLabel,
        action: "member.console_test_access_granted",
        workspaceId: input.workspaceId,
        sessionId: null,
        detail: {
          subjectId: input.subjectId,
          ...(existing ? { narrowedFrom: { role: existing.role } } : {}),
        },
      }),
    );
    return { changed: true };
  });
}

/** Audit row for a removed Console test workspace membership (in the removal's transaction). */
export async function recordConsoleTestWorkspaceAccessRemoved(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    actorSubjectId: string;
    reason: string;
  },
): Promise<void> {
  await withAccountRls(db, input.accountId, (tx) =>
    insertConsoleAuditEvent(tx, {
      accountId: input.accountId,
      actorSubjectId: input.actorSubjectId,
      actorLabel: null,
      action: "member.console_test_access_removed",
      workspaceId: input.workspaceId,
      sessionId: null,
      detail: { subjectId: input.subjectId, reason: input.reason },
    }),
  );
}
