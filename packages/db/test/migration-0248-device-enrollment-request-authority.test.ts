import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0248_device_enrollment_request_authority.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);
const migrationsDir = new URL("../drizzle/", import.meta.url);

describe("migration 0248 device enrollment request authority", () => {
  test("is a rolling old-writer and tenant-authority fence", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain('ADD COLUMN IF NOT EXISTS "enrollment_credential_generation"');
    expect(source).toContain("bind_device_enrollment_credential_generation");
    expect(source).toContain("deny_stale_device_enrollment_requests");
    expect(source).toContain("enrollments_deny_stale_device_requests");
    expect(source).toContain("machine_removal_operations_enrollment_authority_fk");
    expect(source).toContain("NOT VALID");
    expect(source).toContain("VALIDATE CONSTRAINT");
  });

  test("denies ambiguous legacy requests, fences rotation, and rejects cross-tenant receipts", async () => {
    const blank = await acquireBlankTestDatabase("migration-0248-enrollment-request-authority");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const laterMigrations = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql") && file >= migrationName)
        .sort();
      await sql.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of laterMigrations) {
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }
      await migrate(blank.databaseUrl);

      const [accountA] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0248-account-a') returning id`;
      const [workspaceA] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountA!.id}, 'migration-0248-workspace-a') returning id`;
      const [accountB] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0248-account-b') returning id`;
      const [workspaceB] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountB!.id}, 'migration-0248-workspace-b') returning id`;
      const [generationOne] = await sql<{ id: string }[]>`
        insert into enrollments (account_id, workspace_id, pubkey)
        values (${accountA!.id}, ${workspaceA!.id}, 'ed25519:MIGRATION-0248-A') returning id`;
      const [generationTwo] = await sql<{ id: string }[]>`
        insert into enrollments (account_id, workspace_id, pubkey, credential_generation)
        values (${accountB!.id}, ${workspaceB!.id}, 'ed25519:MIGRATION-0248-B', 2) returning id`;
      const [requestOne] = await sql<{ id: string }[]>`
        insert into device_enrollment_requests (
          device_code, user_code, account_id, workspace_id, pubkey, status,
          enrollment_id, approved_at, expires_at
        ) values (
          'migration-0248-device-a', 'M248-A', ${accountA!.id}, ${workspaceA!.id},
          'ed25519:MIGRATION-0248-A', 'approved', ${generationOne!.id}, now(),
          now() + interval '10 minutes'
        ) returning id`;
      const [ambiguousRequest] = await sql<{ id: string }[]>`
        insert into device_enrollment_requests (
          device_code, user_code, account_id, workspace_id, pubkey, status,
          enrollment_id, approved_at, expires_at
        ) values (
          'migration-0248-device-b', 'M248-B', ${accountB!.id}, ${workspaceB!.id},
          'ed25519:MIGRATION-0248-B', 'approved', ${generationTwo!.id}, now(),
          now() + interval '10 minutes'
        ) returning id`;

      // The historical single-column FK admits this mismatched authority tuple.
      const invalidOperationId = crypto.randomUUID();
      await sql`
        insert into machine_removal_operations (
          id, account_id, workspace_id, enrollment_id, operation_key,
          request_fingerprint, outcome, result
        ) values (
          ${invalidOperationId}, ${accountA!.id}, ${workspaceA!.id}, ${generationTwo!.id},
          'migration-0248-invalid', ${"a".repeat(64)}, 'blocked', '{}'::jsonb
        )`;

      await sql`delete from schema_migrations where name = ${migrationName}`;
      let invalidAuthorityError: unknown;
      try {
        await migrate(blank.databaseUrl);
      } catch (error) {
        invalidAuthorityError = error;
      }
      expect(invalidAuthorityError).toMatchObject({ code: "23503" });
      const [notApplied] = await sql<{ applied: boolean }[]>`
        select exists(select 1 from schema_migrations where name = ${migrationName}) as applied`;
      expect(notApplied).toEqual({ applied: false });

      await sql`delete from machine_removal_operations where id = ${invalidOperationId}`;
      await migrate(blank.databaseUrl);

      const requests = await sql<
        Array<{ id: string; status: string; credentialGeneration: number | null }>
      >`
        select id, status,
          enrollment_credential_generation as "credentialGeneration"
        from device_enrollment_requests
        where id in (${requestOne!.id}, ${ambiguousRequest!.id})
        order by id`;
      expect(requests.find((request) => request.id === requestOne!.id)).toMatchObject({
        status: "approved",
        credentialGeneration: 1,
      });
      expect(requests.find((request) => request.id === ambiguousRequest!.id)).toMatchObject({
        status: "denied",
        credentialGeneration: null,
      });

      // A rolling old writer can omit the new field. Approval binds it, and a
      // later enrollment rotation denies it in the same transaction.
      await sql`
        update enrollments set credential_generation = 2 where id = ${generationOne!.id}`;
      const [staleLegacy] = await sql<{ status: string }[]>`
        select status from device_enrollment_requests where id = ${requestOne!.id}`;
      expect(staleLegacy?.status).toBe("denied");

      const [rollingRequest] = await sql<{ id: string }[]>`
        insert into device_enrollment_requests (
          device_code, user_code, account_id, workspace_id, pubkey, expires_at
        ) values (
          'migration-0248-device-rolling', 'M248-R', ${accountA!.id}, ${workspaceA!.id},
          'ed25519:MIGRATION-0248-A', now() + interval '10 minutes'
        ) returning id`;
      const [bound] = await sql<{ credentialGeneration: number }[]>`
        update device_enrollment_requests
        set status = 'approved', enrollment_id = ${generationOne!.id}, approved_at = now()
        where id = ${rollingRequest!.id}
        returning enrollment_credential_generation as "credentialGeneration"`;
      expect(bound?.credentialGeneration).toBe(2);

      await sql`
        update enrollments set credential_generation = 3 where id = ${generationOne!.id}`;
      const [deniedAfterRotation] = await sql<{ status: string }[]>`
        select status from device_enrollment_requests where id = ${rollingRequest!.id}`;
      expect(deniedAfterRotation?.status).toBe("denied");

      let crossTenantError: unknown;
      try {
        await sql`
          insert into machine_removal_operations (
            account_id, workspace_id, enrollment_id, operation_key,
            request_fingerprint, outcome, result
          ) values (
            ${accountA!.id}, ${workspaceA!.id}, ${generationTwo!.id},
            'migration-0248-rejected', ${"b".repeat(64)}, 'blocked', '{}'::jsonb
          )`;
      } catch (error) {
        crossTenantError = error;
      }
      expect(crossTenantError).toMatchObject({ code: "23503" });

      // Lost-response retry remains idempotent.
      await sql`delete from schema_migrations where name = ${migrationName}`;
      await migrate(blank.databaseUrl);
      const [applied] = await sql<{ applied: boolean }[]>`
        select exists(select 1 from schema_migrations where name = ${migrationName}) as applied`;
      expect(applied).toEqual({ applied: true });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
