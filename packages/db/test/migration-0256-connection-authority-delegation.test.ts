import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createSession, getConnectionMetadata } from "../src/index";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0256_connection_authority_delegation.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0256 connection authority delegation", () => {
  test("binds owner authority and exposes only capability-gated pre-use resolution", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "authority_generation" bigint NOT NULL DEFAULT 1');
    expect(source).toContain("resource_kind = 'connection'");
    expect(source).toContain("'connection.use'");
    expect(source).toContain("connection grants require connection.use");
    expect(source).toContain("organization_user_resource_grants_action_contract");
    expect(source).toContain("CREATE OR REPLACE FUNCTION %1$I.resolve_connection_use_authority");
    expect(source).toContain("connection_use_once_consumption_receipts");
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

      const targetSession = await createSession(client.db, {
        accountId: account!.id,
        workspaceId: targetWorkspace!.id,
        initialMessage: "use the delegated personal connection",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: ownerSubjectId },
        model: "test-model",
        sandboxBackend: "none",
        subjectId: ownerSubjectId,
      });
      const [sessionAuthority] = await sql<
        Array<{
          visibility: "user_private" | "workspace_shared";
          authorityEpoch: number;
        }>
      >`
        select visibility, authority_epoch::int as "authorityEpoch"
        from sessions where id = ${targetSession.id}
      `;
      if (!sessionAuthority) throw new Error("target session authority is missing");
      const firstTurnId = crypto.randomUUID();
      const secondTurnId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, execution_generation, position, prompt,
          model, reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
          initiator_subject_id, initiating_human_subject_id
        ) values
          (
            ${firstTurnId}, ${account!.id}, ${targetWorkspace!.id}, ${targetSession.id},
            ${crypto.randomUUID()}, 'connection-authority-first', 'completed', 1, 1,
            'first connection use', 'test-model', 'medium', 'standard', 'none',
            'subject', ${ownerSubjectId}, ${ownerSubjectId}
          ),
          (
            ${secondTurnId}, ${account!.id}, ${targetWorkspace!.id}, ${targetSession.id},
            ${crypto.randomUUID()}, 'connection-authority-second', 'completed', 1, 2,
            'second connection use', 'test-model', 'medium', 'standard', 'none',
            'subject', ${ownerSubjectId}, ${ownerSubjectId}
          )
      `;

      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
          await tx`select set_config('opengeni.subject_id', ${ownerSubjectId}, true)`;
          await tx`
            select * from issue_self_user_resource_grant(
              ${account!.id}::uuid, ${personal.authorityId}::uuid,
              ${targetWorkspace!.id}::uuid, 'provider.delete', 'once',
              ${sessionAuthority.visibility}, ${targetSession.id}::uuid,
              ${sessionAuthority.visibility === "workspace_shared"}
            )
          `;
        }),
      ).rejects.toMatchObject({ code: "22023" });

      const genericGrant = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${ownerSubjectId}, true)`;
        const [row] = await tx<
          Array<{
            grantId: string;
            generation: number;
            status: string;
          }>
        >`
          select grant_id as "grantId", grant_generation::int as generation,
            grant_status as status
          from issue_self_user_resource_grant(
            ${account!.id}::uuid, ${personal.authorityId}::uuid,
            ${targetWorkspace!.id}::uuid, 'connection.use', 'once',
            ${sessionAuthority.visibility}, ${targetSession.id}::uuid,
            ${sessionAuthority.visibility === "workspace_shared"}
          )
        `;
        return row!;
      });
      expect(genericGrant).toMatchObject({ generation: 1, status: "active" });

      const grant = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${ownerSubjectId}, true)`;
        const [row] = await tx<
          Array<{
            grantId: string;
            generation: number;
            status: string;
          }>
        >`
          select grant_id as "grantId", grant_generation::int as generation,
            grant_status as status
          from issue_self_connection_use_grant(
            ${account!.id}::uuid, ${personal.authorityId}::uuid,
            ${targetWorkspace!.id}::uuid, 'once', ${sessionAuthority.visibility},
            ${targetSession.id}::uuid, ${sessionAuthority.visibility === "workspace_shared"}
          )
        `;
        return row!;
      });
      expect(grant).toMatchObject({ generation: 1, status: "active" });
      expect(grant.grantId).toBe(genericGrant.grantId);

      const personalSnapshot = {
        organizationId: account!.id,
        originWorkspaceId: personalWorkspace!.id,
        targetWorkspaceId: targetWorkspace!.id,
        targetSessionId: targetSession.id,
        targetSessionVisibility: sessionAuthority.visibility,
        targetSessionAuthorityEpoch: sessionAuthority.authorityEpoch,
        acceptedWork: { kind: "turn", turnId: firstTurnId },
        connectionId: personal.id,
        connectionGeneration: 1,
        connectionStatus: "active",
        providerDomain: "api.example.com",
        connectionKind: "oauth2",
        scope: "user",
        ownerSubjectId,
        ownerOrganizationMembershipId: membership!.id,
        authoritySource: "user_delegation",
        selectionSources: ["mcp:personal"],
        userDelegation: {
          authorityId: personal.authorityId,
          grantId: grant.grantId,
          organizationId: account!.id,
          workspaceId: targetWorkspace!.id,
          sessionId: targetSession.id,
          action: "connection.use",
          mode: "once",
          context: sessionAuthority.visibility,
          authorityEpoch: sessionAuthority.authorityEpoch,
          authorityGeneration: 1,
          grantGeneration: 1,
        },
      };
      const resolvePersonal = async (snapshot: typeof personalSnapshot) =>
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
          await tx`select set_config('opengeni.subject_id', ${ownerSubjectId}, true)`;
          const [row] = await tx<{ status: string; reason: string | null }[]>`
            select authorization_status as status, denial_reason as reason
            from resolve_connection_use_authority(
              ${account!.id}::uuid, ${targetWorkspace!.id}::uuid,
              ${targetSession.id}::uuid, ${tx.json(snapshot)}::jsonb
            )
          `;
          return row!;
        });
      expect(await resolvePersonal(personalSnapshot)).toEqual({
        status: "authorized",
        reason: null,
      });
      expect(await resolvePersonal(personalSnapshot)).toEqual({
        status: "authorized",
        reason: null,
      });
      expect(
        await resolvePersonal({
          ...personalSnapshot,
          acceptedWork: { kind: "turn", turnId: secondTurnId },
        }),
      ).toEqual({ status: "denied", reason: "grant_already_consumed" });

      const revokedGrant = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${ownerSubjectId}, true)`;
        const [row] = await tx<{ generation: number; status: string }[]>`
          select grant_generation::int as generation, grant_status as status
          from revoke_self_connection_use_grant(
            ${account!.id}::uuid, ${grant.grantId}::uuid
          )
        `;
        return row!;
      });
      expect(revokedGrant).toEqual({ generation: 2, status: "revoked" });
      expect(await resolvePersonal(personalSnapshot)).toEqual({
        status: "denied",
        reason: "grant_generation_changed",
      });

      const workspaceConnection = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', '', true)`;
        const [row] = await tx<
          Array<{
            id: string;
            authorityScope: string;
            authorityId: string | null;
            authorityGeneration: number;
          }>
        >`
          insert into connections (
            account_id, workspace_id, provider_domain, kind, credential_encrypted
          ) values (
            ${account!.id}, ${targetWorkspace!.id}, 'workspace.example.com',
            'api_key', 'workspace-ciphertext'
          ) returning id, authority_scope as "authorityScope",
            authority_id as "authorityId",
            authority_generation::int as "authorityGeneration"
        `;
        return row!;
      });
      expect(workspaceConnection).toMatchObject({
        authorityScope: "workspace",
        authorityId: null,
        authorityGeneration: 1,
      });

      const [revoked] = await sql<{ authorityGeneration: number }[]>`
        update connections set status = 'revoked'
        where id = ${workspaceConnection.id}
        returning authority_generation::int as "authorityGeneration"
      `;
      expect(revoked!.authorityGeneration).toBe(2);

      const missingSessionId = crypto.randomUUID();
      const missingSessionSnapshot = {
        organizationId: account!.id,
        originWorkspaceId: targetWorkspace!.id,
        targetWorkspaceId: targetWorkspace!.id,
        targetSessionId: missingSessionId,
        targetSessionVisibility: "workspace_shared",
        targetSessionAuthorityEpoch: 1,
        acceptedWork: { kind: "turn", turnId: crypto.randomUUID() },
        connectionId: workspaceConnection.id,
        connectionGeneration: 1,
        connectionStatus: "active",
        providerDomain: "workspace.example.com",
        connectionKind: "api_key",
        scope: "workspace",
        ownerSubjectId: null,
        ownerOrganizationMembershipId: null,
        authoritySource: "explicit_workspace",
        selectionSources: ["mcp:workspace"],
        userDelegation: null,
      };
      const resolution = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true)`;
        const [scope] = await tx<{ accountId: string; workspaceId: string }[]>`
          select current_setting('opengeni.account_id', true) as "accountId",
            current_setting('opengeni.workspace_id', true) as "workspaceId"
        `;
        expect(scope).toEqual({
          accountId: account!.id,
          workspaceId: targetWorkspace!.id,
        });
        const [mismatch] = await tx<
          Array<{
            account: boolean;
            workspace: boolean;
            snapshotAccount: boolean;
            snapshotWorkspace: boolean;
            snapshotSession: boolean;
          }>
        >`
          select ${account!.id}::uuid is distinct from
              nullif(current_setting('opengeni.account_id', true), '')::uuid as account,
            ${targetWorkspace!.id}::uuid is distinct from
              nullif(current_setting('opengeni.workspace_id', true), '')::uuid as workspace,
            (${tx.json(missingSessionSnapshot)}::jsonb ->> 'organizationId')
              is distinct from ${account!.id}::uuid::text as "snapshotAccount",
            (${tx.json(missingSessionSnapshot)}::jsonb ->> 'targetWorkspaceId')
              is distinct from ${targetWorkspace!.id}::uuid::text as "snapshotWorkspace",
            (${tx.json(missingSessionSnapshot)}::jsonb ->> 'targetSessionId')
              is distinct from ${missingSessionId}::uuid::text as "snapshotSession"
        `;
        expect(mismatch).toEqual({
          account: false,
          workspace: false,
          snapshotAccount: false,
          snapshotWorkspace: false,
          snapshotSession: false,
        });
        const [row] = await tx<{ status: string; reason: string | null }[]>`
          select authorization_status as status, denial_reason as reason
          from resolve_connection_use_authority(
            ${account!.id}::uuid, ${targetWorkspace!.id}::uuid,
            ${missingSessionId}::uuid,
            ${tx.json(missingSessionSnapshot)}::jsonb
          )
        `;
        return row!;
      });
      expect(resolution).toEqual({
        status: "denied",
        reason: "session_inactive",
      });
    } finally {
      await client.close();
      await sql.end();
      await blank.release();
    }
  }, 300_000);
});
