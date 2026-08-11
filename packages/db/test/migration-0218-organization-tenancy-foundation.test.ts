import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  FORCE_RLS_TABLES,
  nestedPostgresSqlState,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_DML_TABLES,
  type DbClient,
} from "../src";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0218_organization_tenancy_foundation.sql",
);
const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../src/schema.ts");

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_APP_URL;

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL and OPENGENI_ORG_TENANCY_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0218-organization-tenancy");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0218-organization-tenancy] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

describe("migration 0218 organization tenancy foundation", () => {
  test("pins the Drizzle grant index name and ordered columns to migration SQL", async () => {
    const [migration, schema] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(schemaPath, "utf8"),
    ]);

    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "organization_user_resource_grants_id_account_idx"\s+ON "organization_user_resource_grants" \("id", "account_id"\);/u,
    );
    expect(schema).toContain(
      'uniqueIndex("organization_user_resource_grants_id_account_idx").on(\n      table.id,\n      table.accountId,\n    )',
    );

    // Keep this negative guard deterministic: the former name/order drift must
    // never be reintroduced while the migration remains the ledger authority.
    expect(schema).not.toContain("organization_user_resource_grants_account_id_idx");
    expect(schema).not.toContain(
      'uniqueIndex("organization_user_resource_grants_id_account_idx").on(\n      table.accountId,\n      table.id,',
    );
  });

  test("is rolling, additive, legacy-safe, and intentionally runtime-inert", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of [
      "organization_memberships",
      "organization_user_retention_policies",
      "organization_user_resource_authorities",
      "organization_user_resource_grants",
    ] as const) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_DML_TABLES).not.toContain(table);
    }
    expect(migration).toContain(
      `ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'workspace_shared'`,
    );
    expect(migration).toContain(
      `ADD COLUMN IF NOT EXISTS "authority_epoch" integer NOT NULL DEFAULT 1`,
    );
    expect(migration).not.toContain("CREATE POLICY");
    expect(migration).not.toMatch(
      /ALTER TABLE "(?:workspace_variable_sets|rigs|enrollments|codex_subscription_credentials)"/u,
    );
  });

  test("enforces organization identity, personal-workspace uniqueness, and inert authority", async () => {
    if (!shared || !client) return;
    const accountExternalId = `org-tenancy-${crypto.randomUUID()}`;
    const personalAccess = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId,
      accountName: "Organization tenancy",
      workspaceExternalSource: "test",
      workspaceExternalId: `personal-${crypto.randomUUID()}`,
      workspaceName: "Personal workspace",
      subjectId: "human:org-tenancy-owner",
    });
    const provenanceAccess = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId,
      accountName: "Organization tenancy",
      workspaceExternalSource: "test",
      workspaceExternalId: `provenance-${crypto.randomUUID()}`,
      workspaceName: "Provenance workspace",
      subjectId: "human:org-tenancy-owner",
    });
    const foreignAccess = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `foreign-${crypto.randomUUID()}`,
      accountName: "Foreign organization",
      workspaceExternalSource: "test",
      workspaceExternalId: `foreign-workspace-${crypto.randomUUID()}`,
      workspaceName: "Foreign workspace",
      subjectId: "human:foreign-owner",
    });
    const personal = personalAccess.workspaceGrants[0]!;
    const provenance = provenanceAccess.workspaceGrants[0]!;
    const foreign = foreignAccess.workspaceGrants[0]!;

    const [membership] = await shared.admin<{ id: string }[]>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (
        ${personal.accountId}, 'human:org-tenancy-owner', 'active', ${personal.workspaceId}
      ) returning id
    `;
    const [otherMembership] = await shared.admin<{ id: string }[]>`
      insert into organization_memberships (account_id, subject_id, status)
      values (${personal.accountId}, 'human:other-owner', 'suspended')
      returning id
    `;

    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_memberships (account_id, subject_id, status)
          values (${personal.accountId}, 'human:missing-personal-workspace', 'active')
        `,
      "23514",
    );
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_memberships (
            account_id, subject_id, status, personal_workspace_id
          ) values (
            ${foreign.accountId}, 'human:cross-organization', 'active', ${personal.workspaceId}
          )
        `,
      "23503",
    );
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_memberships (
            account_id, subject_id, status, personal_workspace_id
          ) values (
            ${personal.accountId}, 'human:duplicate-personal-workspace', 'active',
            ${personal.workspaceId}
          )
        `,
      "23505",
    );

    const [authority] = await shared.admin<{ id: string }[]>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id
      ) values (
        ${personal.accountId}, ${membership!.id}, 'variable_set', ${crypto.randomUUID()},
        ${provenance.workspaceId}
      ) returning id
    `;
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_user_resource_authorities (
            account_id, organization_membership_id, resource_kind, resource_id
          ) values (
            ${foreign.accountId}, ${membership!.id}, 'rig', ${crypto.randomUUID()}
          )
        `,
      "23503",
    );

    await shared.admin`delete from workspaces where id = ${provenance.workspaceId}`;
    const [provenanceCleared] = await shared.admin<{ originWorkspaceId: string | null }[]>`
      select origin_workspace_id as "originWorkspaceId"
      from organization_user_resource_authorities
      where id = ${authority!.id}
    `;
    expect(provenanceCleared?.originWorkspaceId).toBeNull();

    const session = await createSession(client.db, {
      accountId: personal.accountId,
      workspaceId: personal.workspaceId,
      initialMessage: "legacy session tenancy defaults",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const [tenancy] = await shared.admin<
      {
        ownerMembershipId: string | null;
        visibility: string;
        authorityEpoch: number;
        forkedFromSessionId: string | null;
      }[]
    >`
      select
        owner_organization_membership_id as "ownerMembershipId",
        visibility,
        authority_epoch as "authorityEpoch",
        forked_from_session_id as "forkedFromSessionId"
      from sessions where id = ${session.id}
    `;
    expect(tenancy).toEqual({
      ownerMembershipId: null,
      visibility: "workspace_shared",
      authorityEpoch: 1,
      forkedFromSessionId: null,
    });
    await expectSqlState(
      async () =>
        await shared!.admin`
          update sessions set visibility = 'user_private' where id = ${session.id}
        `,
      "23514",
    );

    await shared.admin`
      insert into organization_user_resource_grants (
        account_id, authority_id, owner_organization_membership_id,
        workspace_id, session_id, action, mode, context, authority_epoch
      ) values (
        ${personal.accountId}, ${authority!.id}, ${membership!.id},
        ${personal.workspaceId}, ${session.id}, 'resource.use', 'session',
        'workspace_shared', 1
      )
    `;
    await shared.admin`
      insert into organization_user_resource_grants (
        account_id, authority_id, owner_organization_membership_id,
        workspace_id, action, mode, context
      ) values (
        ${personal.accountId}, ${authority!.id}, ${membership!.id},
        ${personal.workspaceId}, 'resource.use', 'always', 'workspace_shared'
      )
    `;
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_user_resource_grants (
            account_id, authority_id, owner_organization_membership_id,
            workspace_id, session_id, action, mode, context, authority_epoch
          ) values (
            ${personal.accountId}, ${authority!.id}, ${otherMembership!.id},
            ${personal.workspaceId}, ${session.id}, 'resource.use', 'session',
            'workspace_shared', 1
          )
        `,
      "23503",
    );
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_user_resource_grants (
            account_id, authority_id, owner_organization_membership_id,
            workspace_id, action, mode, context
          ) values (
            ${personal.accountId}, ${authority!.id}, ${membership!.id},
            ${foreign.workspaceId}, 'resource.use', 'always', 'user_private'
          )
        `,
      "23503",
    );
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_user_resource_grants (
            account_id, authority_id, owner_organization_membership_id,
            workspace_id, action, mode, context
          ) values (
            ${personal.accountId}, ${authority!.id}, ${membership!.id},
            ${personal.workspaceId}, 'resource.use', 'once', 'workspace_shared'
          )
        `,
      "23514",
    );
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_user_resource_grants (
            account_id, authority_id, owner_organization_membership_id,
            workspace_id, session_id, action, mode, context, authority_epoch
          ) values (
            ${personal.accountId}, ${authority!.id}, ${membership!.id},
            ${personal.workspaceId}, ${session.id}, 'resource.use', 'always',
            'workspace_shared', 1
          )
        `,
      "23514",
    );
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_user_resource_grants (
            account_id, authority_id, owner_organization_membership_id,
            workspace_id, session_id, action, mode, context, authority_epoch
          ) values (
            ${personal.accountId}, ${authority!.id}, ${membership!.id},
            ${personal.workspaceId}, ${session.id}, 'Resource.Use', 'session',
            'workspace_shared', 1
          )
        `,
      "23514",
    );

    const app = postgres(shared.appUrl, { max: 1 });
    try {
      await expectSqlState(
        async () => await app`select id from organization_user_resource_authorities limit 1`,
        "42501",
      );
    } finally {
      await app.end();
    }
  });
});
