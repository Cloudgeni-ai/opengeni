import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { nestedPostgresSqlState } from "../src";
import postgres from "postgres";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0340-tenancy-backfill-evidence");
  if (!shared && requireRealDatabase) throw new Error("migration 0340 requires PostgreSQL");
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

describe("migration 0340 tenancy backfill activation evidence", () => {
  test("is rolling, preserves the activation signature, and binds six receipt ids", async () => {
    const source = await readFile(
      new URL("../drizzle/0340_tenancy_backfill_activation_evidence.sql", import.meta.url),
      "utf8",
    );
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const reason of [
      "missing_login_identity",
      "organization_identity_mismatch",
      "missing_owner_workspace_membership",
      "membership_terminal_status",
    ]) {
      expect(source).toContain(`'${reason}'`);
    }
    expect(source).toContain("cardinality(backfill_receipt_ids) IN (0, 6)");
    expect(source).toContain("'connections'::text");
    expect(source).toContain("check_tenancy_backfill_activation_evidence(uuid)");
    expect(source).toContain("activate_session_tenancy_product(uuid, text, text, text, text[])");
    expect(source).toContain("connection_use_audit_facts, tenancy_backfill_receipts,");
    expect(source).toContain("tenancy_backfill_unresolved_rows, session_tenancy_activations");
    expect(source).toContain("CREATE FUNCTION lock_session_tenancy_activation_boundary()");
    expect(source).toContain("'session-tenancy-canonical-boundary:v1'");
    const organizationFence = source.indexOf("'organization-membership:'");
    const sourceLocks = source.indexOf("LOCK TABLE", organizationFence);
    const boundaryFence = source.indexOf(
      "PERFORM lock_session_tenancy_activation_boundary()",
      sourceLocks,
    );
    const evidenceRecompute = source.indexOf("inventory_report :=", boundaryFence);
    expect(organizationFence).toBeGreaterThanOrEqual(0);
    expect(sourceLocks).toBeGreaterThan(organizationFence);
    expect(boundaryFence).toBeGreaterThan(sourceLocks);
    expect(evidenceRecompute).toBeGreaterThan(boundaryFence);
    expect(source).not.toContain(
      "GRANT EXECUTE ON FUNCTION check_tenancy_backfill_activation_evidence",
    );
  });

  test("keeps the evidence projection owner-only and fails closed without receipts", async () => {
    if (!shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0340 evidence') returning id`;
    const [acl] = await shared.admin<
      Array<{ evidenceExecutable: boolean; boundaryExecutable: boolean }>
    >`
      select has_function_privilege(
          'opengeni_app', 'check_tenancy_backfill_activation_evidence(uuid)', 'EXECUTE'
        ) as "evidenceExecutable",
        has_function_privilege(
          'opengeni_app', 'lock_session_tenancy_activation_boundary()', 'EXECUTE'
        ) as "boundaryExecutable"`;
    expect(acl).toEqual({ evidenceExecutable: false, boundaryExecutable: false });

    const [report] = await shared.admin.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
      return await transaction<{ evidence: Record<string, unknown> }[]>`
        select check_tenancy_backfill_activation_evidence(${account!.id}::uuid) as evidence`;
    });
    const evidence = report?.evidence;
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      organizationId: account!.id,
      ready: false,
      receiptIds: [],
    });
    const blockers = evidence?.blockers;
    expect(Array.isArray(blockers) ? blockers.length : 0).toBe(6);
  }, 180_000);

  test("classifies and converges only legacy connections with exact live membership", async () => {
    if (!shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0340 connection convergence') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, '0340 connection convergence') returning id`;
    const ownerSubject = `user:${crypto.randomUUID()}`;
    const unresolvedSubject = `user:${crypto.randomUUID()}`;
    const [ownedConnection, unresolvedConnection] = await shared.admin.begin(
      async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await transaction`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await transaction`select set_config('opengeni.subject_id', ${ownerSubject}, true)`;
        const [owned] = await transaction<{ id: string }[]>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${workspace!.id}, ${ownerSubject},
            'owned.example', 'api_key', 'ciphertext'
          ) returning id`;
        await transaction`select set_config('opengeni.subject_id', ${unresolvedSubject}, true)`;
        const [unresolved] = await transaction<{ id: string }[]>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${workspace!.id}, ${unresolvedSubject},
            'unresolved.example', 'api_key', 'ciphertext'
          ) returning id`;
        return [owned!, unresolved!];
      },
    );
    const [membership] = await shared.admin<{ id: string }[]>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (
        ${account!.id}, ${ownerSubject}, 'active', ${workspace!.id}
      ) returning id`;

    const before = await shared.admin.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
      const [row] = await transaction<{ report: Record<string, any> }[]>`
        select classify_organization_connection_authority(
          ${account!.id}::uuid, ${`before-${crypto.randomUUID()}`}
        ) as report`;
      return row!.report;
    });
    expect(before.connections).toEqual({
      total: 2,
      userOwned: 0,
      workspaceOwned: 0,
      deterministicRepairPending: 1,
      unresolved: 2,
    });

    const applied = await shared.admin.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
      const [row] = await transaction<{ report: Record<string, any> }[]>`
        select backfill_organization_connection_authority(
          ${account!.id}::uuid, 100, false
        ) as report`;
      return row!.report;
    });
    expect(applied).toMatchObject({ candidates: 1, upgraded: 1, dryRun: false });
    const [ownedAfter, unresolvedAfter] = await shared.admin<
      Array<{
        id: string;
        scope: string;
        membershipId: string | null;
        authorityId: string | null;
        generation: number;
      }>
    >`
      select id, authority_scope as scope,
        owner_organization_membership_id as "membershipId",
        authority_id as "authorityId", authority_generation::int as generation
      from connections where id in (${ownedConnection.id}, ${unresolvedConnection.id})
      order by provider_domain`;
    expect(ownedAfter).toMatchObject({
      id: ownedConnection.id,
      scope: "user",
      membershipId: membership!.id,
      generation: 2,
    });
    expect(ownedAfter!.authorityId).toBeString();
    expect(unresolvedAfter).toEqual({
      id: unresolvedConnection.id,
      scope: "legacy_user",
      membershipId: null,
      authorityId: null,
      generation: 1,
    });
  }, 180_000);

  test("an existing activation retires unresolved legacy reads and refuses new minting", async () => {
    if (!shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0340 legacy retirement') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, '0340 legacy retirement') returning id`;
    const legacySubject = `user:${crypto.randomUUID()}`;
    const [legacy] = await shared.admin.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
      await transaction`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
      await transaction`select set_config('opengeni.subject_id', ${legacySubject}, true)`;
      return await transaction<{ id: string }[]>`
        insert into connections (
          account_id, workspace_id, subject_id, provider_domain, kind,
          credential_encrypted
        ) values (
          ${account!.id}, ${workspace!.id}, ${legacySubject},
          'retired.example', 'api_key', 'ciphertext'
        ) returning id`;
    });
    // A pre-0340 activation can legitimately carry zero or five receipts.
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${account!.id}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'pre-0340-test'
      )`;

    const writerTriggers = await shared.admin<Array<{ relation: string; enabled: string }>>`
      select trigger.tgrelid::regclass::text as relation, trigger.tgenabled as enabled
      from pg_trigger trigger
      join pg_proc procedure on procedure.oid = trigger.tgfoid
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where not trigger.tgisinternal
        and namespace.nspname = 'opengeni_private'
        and procedure.proname = 'guard_activated_tenancy_writer'
      order by relation`;
    expect(Array.from(writerTriggers)).toEqual([
      { relation: "sandbox_retained_processes", enabled: "O" },
      { relation: "sandbox_workspace_mutation_admissions", enabled: "O" },
    ]);
    let writerFailure: unknown;
    try {
      await shared.admin.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await transaction`
          create temporary table tenancy_cutover_writer_fence_probe (
            account_id uuid not null,
            initiator_kind text not null
          ) on commit drop`;
        await transaction`
          create trigger tenancy_cutover_writer_fence_probe
          before insert on tenancy_cutover_writer_fence_probe
          for each row execute function opengeni_private.guard_activated_tenancy_writer()`;
        await transaction`
          insert into tenancy_cutover_writer_fence_probe (account_id, initiator_kind)
          values (${account!.id}, 'legacy_unattributed')`;
      });
    } catch (error) {
      writerFailure = error;
    }
    expect(nestedPostgresSqlState(writerFailure)).toBe("42501");

    const app = postgres(shared.appUrl, { max: 1, onnotice: () => undefined });
    try {
      const visible = await app.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await transaction`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await transaction`select set_config('opengeni.subject_id', ${legacySubject}, true)`;
        return await transaction<{ id: string }[]>`
          select id from connections where id = ${legacy!.id}`;
      });
      expect(Array.from(visible)).toEqual([]);

      let mintFailure: unknown;
      try {
        await app.begin(async (transaction) => {
          await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await transaction`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
          await transaction`select set_config('opengeni.subject_id', ${legacySubject}, true)`;
          await transaction`
            insert into connections (
              account_id, workspace_id, subject_id, provider_domain, kind,
              credential_encrypted
            ) values (
              ${account!.id}, ${workspace!.id}, ${legacySubject},
              'refused.example', 'api_key', 'ciphertext'
            )`;
        });
      } catch (error) {
        mintFailure = error;
      }
      expect(nestedPostgresSqlState(mintFailure)).toBe("42501");
    } finally {
      await app.end({ timeout: 5 });
    }
  }, 180_000);

  test("parity counts a historical ownerless session through the personal-workspace pointer", async () => {
    if (!shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0340 personal parity') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, '0340 personal parity') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    const subject = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (${account!.id}, ${subject}, 'active', ${workspace!.id})`;
    const sessionId = crypto.randomUUID();
    await shared.admin.unsafe(
      "alter table sessions disable trigger sessions_mark_activity_pending",
    );
    await shared.admin.unsafe(
      "alter table sessions disable trigger sessions_authority_write_fence",
    );
    try {
      await shared.admin`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model, sandbox_backend,
          sandbox_group_id, reasoning_effort, latency_mode, first_party_mcp_tools,
          tool_policy, created_by_kind, created_by_subject_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, '0340 historical',
          'gpt-5', 'none', ${sessionId}, 'medium', 'standard', '[]'::jsonb,
          '{"mode":"workspace_default","inheritedFromSessionId":null}'::jsonb,
          'subject', ${subject}
        )`;
    } finally {
      await shared.admin.unsafe(
        "alter table sessions enable trigger sessions_authority_write_fence",
      );
      await shared.admin.unsafe(
        "alter table sessions enable trigger sessions_mark_activity_pending",
      );
    }
    const report = await shared.admin.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
      const [row] = await transaction<{ report: Record<string, unknown> }[]>`
        select check_organization_tenancy_parity(${account!.id}::uuid, 10, 30) as report`;
      return row!.report;
    });
    expect((report.lanes as Record<string, number>).sessionsAttributableButUnattributed).toBe(1);
  }, 180_000);
});
