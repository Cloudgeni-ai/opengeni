import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  chooseShardedHome,
  selectCodexCredentialLeaseForTurn,
  type CodexRotationAccount,
} from "../../../apps/worker/src/activities/codex-rotation";
import { acquireCodexCredentialLease, createDb } from "../src/index";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

let available = true;
let blank: BlankTestDatabase | null = null;
let databaseUrl = "";

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0053");
  if (!blank) {
    available = false;
    console.warn("[migration-0053] postgres unavailable, skipping");
    return;
  }
  databaseUrl = blank.databaseUrl;
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0053 (Codex credential leases)", () => {
  test("keeps old workers compatible through schema-first rollout, cutover, and feature-off rollback", async () => {
    if (!available) return;

    const admin = postgres(databaseUrl, { max: 1 });
    let app: ReturnType<typeof createDb> | null = null;
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      expect(files.includes("0053_codex_credential_leases.sql")).toBe(true);
      const pre0053 = files.filter((file) => file < "0053_");

      await admin`select pg_advisory_lock(727458)`;
      await admin.unsafe(
        `CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
      );
      for (const file of pre0053) {
        await applyFile(admin, file);
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const accountId = (
        await admin<
          { id: string }[]
        >`insert into managed_accounts (name) values ('migration-0053-account') returning id`
      )[0]!.id;
      const workspaceId = (
        await admin<
          { id: string }[]
        >`insert into workspaces (account_id, name) values (${accountId}, 'legacy-workspace') returning id`
      )[0]!.id;
      const credentials = await admin<{ id: string }[]>`
        insert into codex_subscription_credentials (
          account_id, workspace_id, credential_encrypted, chatgpt_account_id,
          plan_type, status
        ) values
          (${accountId}, ${workspaceId}, 'legacy-a', 'external-a', 'pro', 'active'),
          (${accountId}, ${workspaceId}, 'legacy-b', 'external-b', 'pro', 'active')
        returning id`;
      const credentialA = credentials[0]!.id;
      const credentialB = credentials[1]!.id;
      await admin`
        insert into codex_rotation_settings (
          account_id, workspace_id, active_credential_id,
          rotation_enabled, rotation_strategy
        ) values (${accountId}, ${workspaceId}, ${credentialA}, false, 'most_remaining')`;

      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id, status
        ) values (
          ${sessionId}, ${accountId}, ${workspaceId}, 'legacy turn',
          'codex/gpt-5.6-sol', 'modal', ${sessionId}, 'running'
        )`;
      await admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend
        ) values (
          ${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${crypto.randomUUID()},
          'legacy-workflow', 'running', 1, 'legacy turn',
          'codex/gpt-5.6-sol', 'low', 'modal'
        )`;
      await admin`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;

      // The pre-migration binary knows only these columns and can read its
      // sticky pointer normally. The additive objects do not exist yet.
      const [before] = await admin<
        { active_credential_id: string; rotation_enabled: boolean; rotation_strategy: string }[]
      >`
        select active_credential_id, rotation_enabled, rotation_strategy
        from codex_rotation_settings where workspace_id = ${workspaceId}`;
      expect(before).toEqual({
        active_credential_id: credentialA,
        rotation_enabled: false,
        rotation_strategy: "most_remaining",
      });
      const preColumns = await admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_name = 'codex_rotation_settings'
          and column_name = 'lease_rotation_enabled'`;
      expect(preColumns).toHaveLength(0);

      await applyFile(admin, "0053_codex_credential_leases.sql");
      await admin`
        insert into schema_migrations (name)
        values ('0053_codex_credential_leases.sql') on conflict do nothing`;
      await admin`select pg_advisory_unlock(727458)`;

      // Schema-first rollout preserves all existing rows and keeps both old and
      // new selector bits false. An old binary's column-only read/write remains
      // valid, and an old-style insert cannot opt a new workspace into leasing.
      const [migrated] = await admin<
        {
          active_credential_id: string;
          rotation_enabled: boolean;
          lease_rotation_enabled: boolean;
          rotation_strategy: string;
        }[]
      >`
        select active_credential_id, rotation_enabled,
               lease_rotation_enabled, rotation_strategy
        from codex_rotation_settings where workspace_id = ${workspaceId}`;
      expect(migrated).toEqual({
        active_credential_id: credentialA,
        rotation_enabled: false,
        lease_rotation_enabled: false,
        rotation_strategy: "most_remaining",
      });
      const allocatorColumns = await admin<
        { allocator_enabled: boolean; default_value: string | null }[]
      >`
        select c.allocator_enabled,
               cols.column_default as default_value
        from codex_subscription_credentials c
        cross join information_schema.columns cols
        where c.workspace_id = ${workspaceId}
          and cols.table_schema = current_schema()
          and cols.table_name = 'codex_subscription_credentials'
          and cols.column_name = 'allocator_enabled'
        order by c.id`;
      expect(allocatorColumns).toHaveLength(2);
      expect(allocatorColumns.every((row) => row.allocator_enabled)).toBe(true);
      expect(allocatorColumns.every((row) => row.default_value === "true")).toBe(true);
      await admin`
        update codex_rotation_settings
        set active_credential_id = ${credentialB},
            rotation_enabled = true,
            lease_rotation_enabled = false
        where workspace_id = ${workspaceId}`;
      const rollbackAccounts: CodexRotationAccount[] = [credentialA, credentialB].map((id) => ({
        id,
        chatgptAccountId: null,
        label: null,
        accountEmail: null,
        planType: "pro",
        status: "active",
        allocatorEnabled: true,
        isActive: id === credentialB,
        expiresAt: null,
        lastRefreshAt: null,
        lastError: null,
        primaryUsedPercent: 0,
        primaryResetAt: null,
        secondaryUsedPercent: 0,
        secondaryResetAt: null,
        usageCheckedAt: null,
        exhaustedUntil: null,
        connectorNamespaces: null,
        connectorsCheckedAt: null,
        activeLeaseCount: 0,
        selectionCount: 0,
        lastSelectedAt: null,
      }));
      const rollbackSelection = selectCodexCredentialLeaseForTurn({
        context: {
          accounts: [credentialA, credentialB].map((id) => ({
            id,
            chatgptAccountId: null,
            label: null,
            accountEmail: null,
            planType: "pro",
            status: "active",
            allocatorEnabled: true,
            isActive: id === credentialB,
            expiresAt: null,
            lastRefreshAt: null,
            lastError: null,
            primaryUsedPercent: 0,
            primaryResetAt: null,
            secondaryUsedPercent: 0,
            secondaryResetAt: null,
            usageCheckedAt: null,
            exhaustedUntil: null,
            connectorNamespaces: null,
            connectorsCheckedAt: null,
            activeLeaseCount: 0,
            selectionCount: 0,
            lastSelectedAt: null,
          })),
          activeCredentialId: credentialB,
          rotationEnabled: true,
          leaseRotationEnabled: false,
          rotationStrategy: "most_remaining",
          existingCredentialId: null,
          policyScope: null,
          unavailableDiagnostics: [],
        },
        leasingEnabled: false,
        sessionId: "session-test",
        sessionPinSource: null,
        sessionPinnedCredentialId: null,
        sessionLastCredentialId: credentialA,
        nearExhaustionPct: 90,
        now: new Date(),
      });
      // OPE-36: rotation-enabled always behaves as sticky-sharded, so the
      // rollback selection is the session's deterministic sharded home (the
      // stored legacy strategy is normalized) — what matters for old-binary
      // compatibility is that selection WORKS and never touches the lease table.
      const expectedHome = chooseShardedHome({
        sessionId: "session-test",
        currentPolicyPin: null,
        accounts: rollbackAccounts,
        nearExhaustionPct: 90,
        now: new Date(),
      });
      expect(expectedHome.kind).toBe("home");
      expect(rollbackSelection.credentialId).toBe(
        expectedHome.kind === "home" ? expectedHome.credentialId : null,
      );
      const [inert] = await admin<{ count: number }[]>`
        select count(*)::int as count from codex_credential_leases`;
      expect(inert!.count).toBe(0);

      const appUrl = new URL(databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      app = createDb(appUrl.toString(), { max: 2 });

      // Even when the compatible deployment flag is on, the workspace bit is
      // the cutover fence: legacy selection may run, but no lease/cursor write
      // is allowed until that row is explicitly enabled.
      const beforeWorkspaceCutover = await acquireCodexCredentialLease(
        app.db,
        {
          accountId,
          workspaceId,
          turnId,
          holderId: "migration-0053-pre-cutover",
          advanceActivePointer: true,
        },
        (context) =>
          selectCodexCredentialLeaseForTurn({
            context,
            leasingEnabled: true,
            sessionId: "session-test",
            sessionPinSource: null,
            sessionPinnedCredentialId: null,
            sessionLastCredentialId: credentialA,
            nearExhaustionPct: 90,
            now: new Date(),
          }),
      );
      // OPE-36: unpinned + rotation-enabled selects the session's sharded home
      // (stored strategy normalized), not the workspace active pointer.
      expect(beforeWorkspaceCutover.credentialId).toBe(
        expectedHome.kind === "home" ? expectedHome.credentialId : null,
      );
      expect(beforeWorkspaceCutover.holderId).toBeNull();
      expect(beforeWorkspaceCutover.generation).toBeNull();
      const [stillInert] = await admin<{ count: number }[]>`
        select count(*)::int as count from codex_credential_leases`;
      expect(stillInert!.count).toBe(0);

      // Full cutover synchronizes user intent and the revision-aware bit. The
      // current worker can then create a fenced lease while an old binary's
      // narrow read remains valid against the same additive schema.
      await admin`
        update codex_rotation_settings
        set rotation_enabled = true, lease_rotation_enabled = true
        where workspace_id = ${workspaceId}`;
      const leased = await acquireCodexCredentialLease(
        app.db,
        {
          accountId,
          workspaceId,
          turnId,
          holderId: "migration-0053-new-worker",
          advanceActivePointer: true,
        },
        (context) =>
          selectCodexCredentialLeaseForTurn({
            context,
            leasingEnabled: true,
            sessionId: "session-test",
            sessionPinSource: null,
            sessionPinnedCredentialId: null,
            sessionLastCredentialId: null,
            nearExhaustionPct: 90,
            now: new Date(),
          }),
      );
      expect(leased.credentialId).not.toBeNull();
      if (!leased.credentialId) throw new Error("expected migration cutover lease");
      expect([credentialA, credentialB]).toContain(leased.credentialId);
      const [liveLease] = await admin<{ count: number }[]>`
        select count(*)::int as count from codex_credential_leases
        where workspace_id = ${workspaceId} and turn_id = ${turnId}`;
      expect(liveLease!.count).toBe(1);
      const [oldWorkerAfterCutover] = await admin<
        { active_credential_id: string; rotation_enabled: boolean; rotation_strategy: string }[]
      >`
        select active_credential_id, rotation_enabled, rotation_strategy
        from codex_rotation_settings where workspace_id = ${workspaceId}`;
      expect(oldWorkerAfterCutover?.rotation_enabled).toBe(true);
      expect(oldWorkerAfterCutover?.rotation_strategy).toBe("most_remaining");

      // Immediate rollback is configuration-only: a current/old worker with
      // leasing disabled again uses the active pointer and never needs to drop
      // the additive row/table. Re-running the real migration chain is a no-op.
      await admin`
        update codex_rotation_settings
        set rotation_enabled = false, lease_rotation_enabled = false
        where workspace_id = ${workspaceId}`;
      const featureOffAgain = selectCodexCredentialLeaseForTurn({
        context: {
          ...rollbackSelectionContext(credentialA, credentialB),
          activeCredentialId: oldWorkerAfterCutover!.active_credential_id,
          rotationEnabled: false,
          leaseRotationEnabled: false,
        },
        leasingEnabled: false,
        sessionId: "session-test",
        sessionPinSource: null,
        sessionPinnedCredentialId: null,
        sessionLastCredentialId: leased.credentialId,
        nearExhaustionPct: 90,
        now: new Date(),
      });
      // Rotation OFF is untouched by OPE-36: the selector returns the workspace
      // active pointer, exactly as before.
      expect(featureOffAgain.credentialId).toBe(oldWorkerAfterCutover!.active_credential_id);
      await migrate(databaseUrl);
      const [afterIdempotentMigrate] = await admin<
        { count: number; lease_rotation_enabled: boolean }[]
      >`
        select count(l.id)::int as count, bool_or(r.lease_rotation_enabled) as lease_rotation_enabled
        from codex_rotation_settings r
        left join codex_credential_leases l on l.workspace_id = r.workspace_id
        where r.workspace_id = ${workspaceId}`;
      expect(afterIdempotentMigrate).toEqual({ count: 1, lease_rotation_enabled: false });
    } finally {
      await app?.close().catch(() => undefined);
      await admin.end();
    }
  }, 180_000);
});

function rollbackSelectionContext(credentialA: string, credentialB: string) {
  return {
    accounts: [credentialA, credentialB].map((id) => ({
      id,
      chatgptAccountId: null,
      label: null,
      accountEmail: null,
      planType: "pro",
      status: "active",
      allocatorEnabled: true,
      isActive: false,
      expiresAt: null,
      lastRefreshAt: null,
      lastError: null,
      primaryUsedPercent: 0,
      primaryResetAt: null,
      secondaryUsedPercent: 0,
      secondaryResetAt: null,
      usageCheckedAt: null,
      exhaustedUntil: null,
      connectorNamespaces: null,
      connectorsCheckedAt: null,
      activeLeaseCount: 0,
      selectionCount: 0,
      lastSelectedAt: null,
    })),
    activeCredentialId: credentialB,
    rotationEnabled: true,
    leaseRotationEnabled: true,
    rotationStrategy: "most_remaining",
    existingCredentialId: null,
    policyScope: null,
    unavailableDiagnostics: [],
  };
}
