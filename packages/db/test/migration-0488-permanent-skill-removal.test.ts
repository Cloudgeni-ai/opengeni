import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { applySkillLifecycle, bootstrapWorkspace, createDb, listSkillRecords } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

test("permanent Skill deletion works with a NOSUPERUSER NOBYPASSRLS migration owner", async () => {
  const localOwner = process.env.OPENGENI_SKILL_REMOVE_OWNER_URL;
  const localAdmin = process.env.OPENGENI_SKILL_REMOVE_ADMIN_URL;
  const fixture =
    localOwner && localAdmin
      ? {
          ownerUrl: localOwner,
          adminUrl: localAdmin,
          ownerRole: decodeURIComponent(new URL(localOwner).username),
          admin: postgres(localAdmin, { max: 1 }),
          appPassword: "local-removal-fixture",
          release: async () => {},
        }
      : await acquireOwnerMigratedTestDatabase("permanent-skill-removal");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  let client: ReturnType<typeof createDb> | undefined;
  try {
    await migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(fixture.adminUrl, {
      appPassword: fixture.appPassword,
      temporalDatabases: [],
    });
    const app = new URL(fixture.adminUrl);
    app.username = "opengeni_app";
    app.password = fixture.appPassword;
    client = createDb(app.toString());
    const grant = (
      await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: crypto.randomUUID(),
        accountName: "Removal",
        workspaceExternalSource: "test",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Removal",
        subjectId: "human:removal",
      })
    ).workspaceGrants[0]!;
    const context = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: { kind: "human", principalKind: "human_session", subjectId: grant.subjectId } as const,
    };
    const id = crypto.randomUUID();
    const saved = await applySkillLifecycle(client.db, context, {
      operation: "save",
      operationId: crypto.randomUUID(),
      skillId: id,
      stableKey: `test-${id}`,
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      reason: "Test",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: removal-test\ndescription: Removal fixture\n---\nDelete me.",
        },
      ],
    });
    const receipt = await applySkillLifecycle(client.db, context, {
      operation: "remove",
      operationId: crypto.randomUUID(),
      skillId: id,
      expectedRevisionId: saved.revisionId,
      expectedScopeVersion: 1,
      reason: "Permanent deletion",
    });
    expect(receipt.removed).toBe(true);
    expect(await listSkillRecords(client.db, context, { skillId: id })).toHaveLength(0);
    const rows =
      await fixture.admin`SELECT id FROM preference_registry_revisions WHERE preference_id=${id}`;
    expect(rows).toHaveLength(0);
    const [role] =
      await fixture.admin`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=${fixture.ownerRole}`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const tables =
      await fixture.admin`SELECT relname,relforcerowsecurity FROM pg_class WHERE relname IN
      ('preference_registry_preferences','preference_registry_revisions','preference_registry_events','skill_write_receipts','capability_facet_installations')`;
    expect(tables).toHaveLength(5);
    expect(tables.every((row) => row.relforcerowsecurity)).toBe(true);
  } finally {
    await client?.close();
    if (localOwner && localAdmin) await fixture.admin.end();
    await fixture.release();
  }
}, 180_000);
