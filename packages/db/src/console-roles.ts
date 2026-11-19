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
import type { ConsoleMemberRole, ConsoleMemberRoleEntry } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { insertConsoleAuditEvent } from "./console";
import { rawRows, withAccountRls, type Database } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

export type ConsoleRoleTarget = { subjectId: string } | { invitationId: string };

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
 * administers the organization.
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
  },
): Promise<{ entry: ConsoleMemberRoleEntry; from: ConsoleMemberRole; changed: boolean }> {
  return await withAccountRls(db, input.accountId, (tx) =>
    upsertRole(tx, {
      ...input,
      ...(input.reason ? { detail: { reason: input.reason } } : {}),
    }),
  );
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
 * When a person accepts an invitation, the Console role it carried becomes
 * theirs, once: a replayed acceptance never overwrites a role an admin set
 * later. Returns the role applied, or null when the invitation carried none
 * (or it was already applied).
 */
export async function applyInvitationConsoleRole(
  db: Database,
  input: { accountId: string; invitationId: string; subjectId: string },
): Promise<ConsoleMemberRole | null> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [invitation] = await rawRows<{ role: string; updated_by_subject_id: string }>(
      tx,
      sql`select role, updated_by_subject_id from organization_console_roles
        where account_id = ${input.accountId}::uuid
          and invitation_id = ${input.invitationId}::uuid
          and applied_at is null
        for update`,
    );
    if (!invitation) return null;
    await rawRows(
      tx,
      sql`update organization_console_roles set applied_at = now()
        where account_id = ${input.accountId}::uuid
          and invitation_id = ${input.invitationId}::uuid`,
    );
    const role = normalizedRole(invitation.role);
    await upsertRole(tx, {
      accountId: input.accountId,
      target: { subjectId: input.subjectId },
      role,
      actorSubjectId: invitation.updated_by_subject_id,
      actorLabel: null,
      detail: { invitationId: input.invitationId, reason: "invitation_accepted" },
    });
    return role;
  });
}
