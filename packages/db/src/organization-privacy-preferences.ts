import { eq, sql } from "drizzle-orm";

import { type Database, rawRows, setSubjectRlsContext, withRlsContext } from "./database";
import { currentCreditDebitAttribution } from "./credit-debit-attribution";
import * as schema from "./schema";

/**
 * An organization's stored privacy choices (migration 0725). Deployment limits
 * are applied on top of these in the application; this is only what the
 * organization chose. No row reads as Workspace and on.
 */
export type OrganizationPrivacyPreferences = {
  defaultVisibility: "workspace_shared" | "user_private";
  /**
   * Off: only the organization's owners and admins connect new machines of
   * their own (1148). Machines already connected keep working.
   */
  membersConnectOwnMachines: boolean;
  adminsSeePrivateSchedules: boolean;
  /** Off: people neither see nor start new work in their Personal workspace (0918). */
  personalWorkspacesEnabled: boolean;
  /**
   * The most each person spends from the organization's credits in their own
   * Personal workspace per calendar month, in USD micros (1147). Null: no limit.
   */
  personalWorkspaceMonthlyCredits: number | null;
  updatedAt: string | null;
};

async function readPreferences(
  scopedDb: Database,
  accountId: string,
): Promise<OrganizationPrivacyPreferences> {
  const [row] = await scopedDb
    .select()
    .from(schema.organizationPrivacyPreferences)
    .where(eq(schema.organizationPrivacyPreferences.accountId, accountId))
    .limit(1);
  return {
    defaultVisibility: row?.defaultVisibility ?? "workspace_shared",
    membersConnectOwnMachines: row?.membersConnectOwnMachines ?? true,
    adminsSeePrivateSchedules: row?.adminsSeePrivateSchedules ?? true,
    personalWorkspacesEnabled: row?.personalWorkspacesEnabled ?? true,
    personalWorkspaceMonthlyCredits: row?.personalWorkspaceMonthlyCredits ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** The organization's stored privacy choices. Readable by any member. */
export async function getOrganizationPrivacyPreferences(
  db: Database,
  accountId: string,
): Promise<OrganizationPrivacyPreferences> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (scopedDb) =>
    readPreferences(scopedDb, accountId),
  );
}

/**
 * True when this is a Personal workspace in an organization whose owners and
 * admins turned Personal workspaces off: nobody starts new chats or schedules
 * there. A shared workspace, or any workspace while the setting is on, is open.
 */
export async function personalWorkspaceClosedToNewWork(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      if ((await readPreferences(scopedDb, input.accountId)).personalWorkspacesEnabled) {
        return false;
      }
      const [row] = await rawRows<{ kind: string | null }>(
        scopedDb,
        sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid) as kind`,
      );
      return row?.kind === "personal";
    },
  );
}

/**
 * What decides whether a member may connect a machine of their own here: the
 * organization's "Members connect their own machines" switch, and whether
 * this is a Personal workspace, where a workspace machine is also its owner's
 * own. The workspace is only looked up while the switch is off.
 */
export type OwnMachineConnectPolicy = {
  membersConnectOwnMachines: boolean;
  personalWorkspace: boolean;
};

export async function getOwnMachineConnectPolicy(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<OwnMachineConnectPolicy> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      if ((await readPreferences(scopedDb, input.accountId)).membersConnectOwnMachines) {
        return { membersConnectOwnMachines: true, personalWorkspace: false };
      }
      const [row] = await rawRows<{ kind: string | null }>(
        scopedDb,
        sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid) as kind`,
      );
      return { membersConnectOwnMachines: false, personalWorkspace: row?.kind === "personal" };
    },
  );
}

/**
 * Change the organization's privacy choices. Only an active owner or admin,
 * or an organization key with administration rights, may; the database raises
 * 42501 for anyone else. Omitted fields keep their current value.
 */
export async function updateOrganizationPrivacyPreferences(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    defaultVisibility?: "workspace_shared" | "user_private";
    membersConnectOwnMachines?: boolean;
    adminsSeePrivateSchedules?: boolean;
    personalWorkspacesEnabled?: boolean;
    /** Null removes the limit. */
    personalWorkspaceMonthlyCredits?: number | null;
  },
): Promise<OrganizationPrivacyPreferences> {
  const credits = input.personalWorkspaceMonthlyCredits;
  if (credits !== undefined && credits !== null && !(Number.isSafeInteger(credits) && credits >= 0))
    throw new Error("personalWorkspaceMonthlyCredits must be a non-negative safe integer");
  // Like workspace budgets (usage-allowances.ts), agent attempts never author
  // allowance policy, whatever actor they present.
  if (credits !== undefined && currentCreditDebitAttribution().kind === "turn")
    throw new Error("Agent attempts cannot change usage allowances");
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      // The same check as the Only me setting: an active owner or admin, or an
      // organization key with administration rights.
      await scopedDb.execute(sql`
        select get_organization_private_session_settings(
          ${input.organizationId}::uuid,
          ${input.actorSubjectId}
        )
      `);
      // Write only the fields that change, so two admins changing different
      // choices at the same time never undo each other.
      const changed = {
        ...(input.defaultVisibility !== undefined
          ? { defaultVisibility: input.defaultVisibility }
          : {}),
        ...(input.membersConnectOwnMachines !== undefined
          ? { membersConnectOwnMachines: input.membersConnectOwnMachines }
          : {}),
        ...(input.adminsSeePrivateSchedules !== undefined
          ? { adminsSeePrivateSchedules: input.adminsSeePrivateSchedules }
          : {}),
        ...(input.personalWorkspacesEnabled !== undefined
          ? { personalWorkspacesEnabled: input.personalWorkspacesEnabled }
          : {}),
        ...(credits !== undefined ? { personalWorkspaceMonthlyCredits: credits } : {}),
      };
      await scopedDb
        .insert(schema.organizationPrivacyPreferences)
        .values({
          accountId: input.organizationId,
          ...changed,
          updatedBySubjectId: input.actorSubjectId,
        })
        .onConflictDoUpdate({
          target: schema.organizationPrivacyPreferences.accountId,
          set: { ...changed, updatedBySubjectId: input.actorSubjectId, updatedAt: new Date() },
        });
      return await readPreferences(scopedDb, input.organizationId);
    },
  );
}
