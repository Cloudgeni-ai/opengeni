import { eq, sql } from "drizzle-orm";

import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import * as schema from "./schema";

/**
 * An organization's stored privacy choices (migration 0725). Deployment limits
 * are applied on top of these in the application; this is only what the
 * organization chose. No row reads as Workspace and on.
 */
export type OrganizationPrivacyPreferences = {
  defaultVisibility: "workspace_shared" | "user_private";
  adminsSeePrivateSchedules: boolean;
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
    adminsSeePrivateSchedules: row?.adminsSeePrivateSchedules ?? true,
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
    adminsSeePrivateSchedules?: boolean;
  },
): Promise<OrganizationPrivacyPreferences> {
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
        ...(input.adminsSeePrivateSchedules !== undefined
          ? { adminsSeePrivateSchedules: input.adminsSeePrivateSchedules }
          : {}),
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
