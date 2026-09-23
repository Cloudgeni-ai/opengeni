import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, getConnectionMetadata } from "../src/index";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0256_connection_authority_delegation.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0256 connection authority delegation", () => {
  test("retains canonical owner metadata while retiring connection-grant execution", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "authority_generation" bigint NOT NULL DEFAULT 1');
    expect(source).toContain("resource_kind = 'connection'");
    expect(source).toContain("'connection.use'");
    expect(source).toContain("connection grants require connection.use");
    expect(source).toContain("organization_user_resource_grants_action_contract");
    expect(source).toContain("CREATE OR REPLACE FUNCTION %1$I.resolve_connection_use_authority");
    expect(source).toContain("connection_use_once_consumption_receipts");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.bind_connection_authority() FROM PUBLIC",
    );
    expect(source).toContain("REVOKE ALL ON TABLE connection_use_once_consumption_receipts");
    expect(source).not.toMatch(/credential_encrypted\s*(?:->|#>|#>>)|decrypt/iu);
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[0-9a-f]{64}$/u);

    const externalDatabaseUrl = process.env.OPENGENI_TEST_DATABASE_URL?.trim();
    const blank = externalDatabaseUrl
      ? { databaseUrl: externalDatabaseUrl, release: async () => undefined }
      : await acquireBlankTestDatabase("migration-0256-connection-authority");
    if (!blank && requireRealDatabase) {
      throw new Error(
        "[migration-0256-connection-authority] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    if (!blank) return;

    await migrate(blank.databaseUrl);
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    const client = createDb(blank.databaseUrl, { max: 1 });
    try {
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('connection-authority-account') returning id
      `;
      const [personalWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'connection-owner-home') returning id
      `;
      const [targetWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'connection-target') returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values
          (${personalWorkspace!.id}, ${account!.id}),
          (${targetWorkspace!.id}, ${account!.id})
      `;
      const ownerSubjectId = `user:${crypto.randomUUID()}`;
      const [membership] = await sql<{ id: string }[]>`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id
        ) values (
          ${account!.id}, ${ownerSubjectId}, 'active', ${personalWorkspace!.id}
        ) returning id
      `;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${account!.id}, ${targetWorkspace!.id}, ${ownerSubjectId})
      `;

      const legacySubjectId = `legacy:${crypto.randomUUID()}`;
      const legacy = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${legacySubjectId}, true)`;
        const [row] = await tx<
          Array<{
            authorityScope: string;
            authorityId: string | null;
            ownerMembershipId: string | null;
          }>
        >`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${targetWorkspace!.id}, ${legacySubjectId},
            'legacy.example.com', 'api_key', 'legacy-ciphertext'
          ) returning authority_scope as "authorityScope",
            authority_id as "authorityId",
            owner_organization_membership_id as "ownerMembershipId"
        `;
        return row!;
      });
      expect(legacy).toEqual({
        authorityScope: "legacy_user",
        authorityId: null,
        ownerMembershipId: null,
      });

      const personal = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${personalWorkspace!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${ownerSubjectId}, true)`;
        const [row] = await tx<
          Array<{
            id: string;
            authorityScope: string;
            authorityId: string;
            ownerMembershipId: string;
            originWorkspaceId: string;
            authorityGeneration: number;
          }>
        >`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${personalWorkspace!.id}, ${ownerSubjectId},
            'api.example.com', 'oauth2', 'ciphertext-never-read-by-authority'
          ) returning id, authority_scope as "authorityScope",
            authority_id as "authorityId",
            owner_organization_membership_id as "ownerMembershipId",
            origin_workspace_id as "originWorkspaceId",
            authority_generation::int as "authorityGeneration"
        `;
        return row!;
      });
      expect(personal).toMatchObject({
        authorityScope: "user",
        ownerMembershipId: membership!.id,
        originWorkspaceId: personalWorkspace!.id,
        authorityGeneration: 1,
      });
      const ownerMetadata = await getConnectionMetadata(
        client.db,
        personalWorkspace!.id,
        personal.id,
        ownerSubjectId,
      );
      expect(ownerMetadata?.authorityId).toBe(personal.authorityId);
      const [authority] = await sql<
        Array<{
          resourceKind: string;
          resourceId: string;
          membershipId: string;
        }>
      >`
        select resource_kind as "resourceKind", resource_id as "resourceId",
          organization_membership_id as "membershipId"
        from organization_user_resource_authorities
        where id = ${personal.authorityId}
      `;
      expect(authority).toEqual({
        resourceKind: "connection",
        resourceId: personal.id,
        membershipId: membership!.id,
      });

      // Sender-owned execution retains canonical ownership, never native grants.
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true),
          set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true),
          set_config('opengeni.subject_id', ${ownerSubjectId}, true)`;
          await tx`select * from issue_self_user_resource_grant(
          ${account!.id}::uuid, ${personal.authorityId}::uuid,
          ${targetWorkspace!.id}::uuid, 'connection.use', 'always',
          'workspace_shared', null::uuid, true)`;
        }),
      ).rejects.toMatchObject({ code: "22023" });
      const [retired] = await sql`select to_regprocedure(
        'issue_self_connection_use_grant(uuid,uuid,uuid,text,text,uuid,boolean)'
      ) is null as absent`;
      expect(retired?.absent).toBe(true);
    } finally {
      await client.close();
      await sql.end();
      await blank.release();
    }
  }, 300_000);
});
