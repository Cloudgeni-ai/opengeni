import { expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readdir } from "node:fs/promises";
import postgres from "postgres";

import {
  createDb,
  createOrganizationWorkspace,
  deleteWorkspaceIfQuiescent,
  ensureManagedAccessForUser,
  listSelfOrganizationMemberships,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationsDirectoryUrl = new URL("../drizzle/", import.meta.url);

test("preserves legacy create outcomes and custom runtime-role access across migration 0398", async () => {
  const blank = await acquireBlankTestDatabase("organization-workspace-management-rolling");
  if (!blank) {
    if (requireRealDatabase) throw new Error("migration 0398 requires real PostgreSQL");
    return;
  }

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const customRole = `og_workspace_admin_${suffix}`;
  const customPassword = crypto.randomUUID();
  const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
  let client: DbClient | null = null;

  const roleUrl = new URL(blank.databaseUrl);
  roleUrl.username = customRole;
  roleUrl.password = customPassword;

  try {
    await admin.unsafe(`CREATE TABLE schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const migrationFiles = (await readdir(migrationsDirectoryUrl))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const heldMigrations = migrationFiles.filter(
      (file) =>
        Buffer.compare(
          Buffer.from(file, "utf8"),
          Buffer.from("0398_organization_workspace_management_entry.sql", "utf8"),
        ) >= 0,
    );
    for (const file of heldMigrations) {
      await admin`insert into schema_migrations (name) values (${file})`;
    }

    await migrate(blank.databaseUrl, undefined, {
      applicationDatabaseRoles: [customRole],
    });
    // Current access bootstrap writes the complete control-row shape. Keep
    // these nullable adapter fields while this fixture replays only 0398;
    // 0420 remains held and this disposable database is released below.
    await admin`
      alter table workspace_inference_controls
      add column timer_id uuid,
      add column timer_action text,
      add column timer_due_at timestamptz,
      add column timer_pause_for_seconds integer,
      add column timer_pause_revision bigint`;
    await provisionRoles(blank.databaseUrl, {
      appRole: customRole,
      appPassword: customPassword,
      rlsStrategy: "force",
    });
    client = createDb(roleUrl.toString(), { max: 2, rlsStrategy: "force" });

    const userId = crypto.randomUUID();
    const subjectId = `user:${userId}`;
    const email = `workspace-admin-${userId}@example.test`;
    await ensureManagedAccessForUser(client.db, {
      userId,
      email,
      name: "Workspace Owner",
    });
    await admin`
      insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Workspace Owner', ${email}, true)
      on conflict (id) do update set name = excluded.name, email = excluded.email`;
    const [membership] = await listSelfOrganizationMemberships(client.db, subjectId);
    expect(membership).toBeDefined();

    const legacyOperationId = crypto.randomUUID();
    const legacyWorkspace = await createOrganizationWorkspace(client.db, {
      organizationId: membership!.organizationId,
      actorSubjectId: subjectId,
      name: "Legacy shared workspace",
      operationId: legacyOperationId,
    });
    expect(legacyWorkspace.members).toEqual([]);

    await admin`
      delete from schema_migrations
      where name = '0398_organization_workspace_management_entry.sql'`;
    await migrate(blank.databaseUrl, undefined, {
      applicationDatabaseRoles: [customRole],
    });

    const [acl] = await admin<
      Array<{ wrapper: boolean; administration: boolean; bypass: boolean }>
    >`select
      has_function_privilege(
        ${customRole}, 'organization_workspace_command(jsonb)', 'EXECUTE'
      ) as wrapper,
      has_function_privilege(
        ${customRole},
        'authorize_organization_shared_workspace_administration(uuid,uuid,text)',
        'EXECUTE'
      ) as administration,
      has_function_privilege(
        ${customRole}, 'organization_workspace_command_without_creator_access(jsonb)', 'EXECUTE'
      ) as bypass`;
    expect(acl).toEqual({ wrapper: true, administration: true, bypass: false });

    const replayedLegacyWorkspace = await createOrganizationWorkspace(client.db, {
      organizationId: membership!.organizationId,
      actorSubjectId: subjectId,
      name: "Legacy shared workspace",
      operationId: legacyOperationId,
    });
    expect(replayedLegacyWorkspace).toEqual(legacyWorkspace);
    expect(replayedLegacyWorkspace.members).toEqual([]);

    const newWorkspace = await createOrganizationWorkspace(client.db, {
      organizationId: membership!.organizationId,
      actorSubjectId: subjectId,
      name: "New shared workspace",
      operationId: crypto.randomUUID(),
    });
    expect(newWorkspace.members).toEqual([
      expect.objectContaining({
        organizationMembershipId: membership!.id,
        subjectId,
        role: "admin",
      }),
    ]);
    // This fixture holds 0432 while exercising the current deletion adapter.
    // Supply its FK timing contract without replaying the Skill cutover or
    // changing the 0398 authorization/replay behavior under test.
    await admin.unsafe(`
      ALTER TABLE preference_registry_preferences
        ALTER CONSTRAINT preference_registry_preferences_superseded_by_fk DEFERRABLE INITIALLY DEFERRED,
        ALTER CONSTRAINT preference_registry_preferences_active_revision_fk DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE preference_registry_revisions
        ALTER CONSTRAINT preference_registry_revisions_corrects_revision_id_fkey DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE preference_registry_events
        ALTER CONSTRAINT preference_registry_events_related_fk DEFERRABLE INITIALLY DEFERRED,
        ALTER CONSTRAINT preference_registry_events_old_revision_fk DEFERRABLE INITIALLY DEFERRED,
        ALTER CONSTRAINT preference_registry_events_new_revision_fk DEFERRABLE INITIALLY DEFERRED;
    `);
    expect(
      await deleteWorkspaceIfQuiescent(client.db, {
        accountId: membership!.organizationId,
        workspaceId: newWorkspace.id,
        organizationAdministratorSubjectId: subjectId,
      }),
    ).toMatchObject({ status: "deleted" });
  } finally {
    await client?.close().catch(() => undefined);
    await admin.unsafe(`DROP OWNED BY "${customRole}"`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS "${customRole}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    await blank.release();
  }
}, 900_000);
