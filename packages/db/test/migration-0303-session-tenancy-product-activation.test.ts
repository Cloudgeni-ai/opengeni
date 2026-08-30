import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { assertRuntimeDatabasePosture, createDb, nestedPostgresSqlState } from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0303-session-tenancy-product-activation");
  if (!shared && requireRealDatabase) throw new Error("migration 0303 requires PostgreSQL");
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

const BACKFILL_FAMILIES = [
  "organization_memberships",
  "sessions",
  "variable_sets",
  "rigs",
  "machines",
  "connections",
] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function reportDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function settleBackfillEvidence(accountId: string): Promise<string[]> {
  return await shared!.admin.begin(async (transaction) => {
    await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
    const receiptIds: string[] = [];
    for (const family of BACKFILL_FAMILIES) {
      const [opened] = await transaction<{ id: string }[]>`
        select open_tenancy_backfill_receipt(
          ${accountId}::uuid, ${family}, ${`activation-${family}-${crypto.randomUUID()}`}
        ) as id`;
      await transaction`
        select complete_tenancy_backfill_receipt(${opened!.id}::uuid, 0, 0, 'completed')`;
      receiptIds.push(opened!.id);
    }
    return receiptIds;
  });
}

async function account(options?: { withEvidence?: boolean }): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('0303 activation') returning id`;
  if (options?.withEvidence !== false) await settleBackfillEvidence(row!.id);
  return row!.id;
}

async function activationDigests(accountId: string): Promise<{
  inventory: string;
  parity: string;
}> {
  return await shared!.admin.begin(async (transaction) => {
    await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
    const [reports] = await transaction<{ inventory: unknown; parity: unknown }[]>`
      select inventory_organization_tenancy(${accountId}::uuid) as inventory,
        check_organization_tenancy_parity(${accountId}::uuid, 10, 30) as parity`;
    return {
      inventory: reportDigest(reports!.inventory),
      parity: reportDigest(reports!.parity),
    };
  });
}

async function activate(accountId: string, inventory?: string) {
  const digests = await activationDigests(accountId);
  return await shared!.admin<
    Array<{ accountId: string; activationVersion: number; replay: boolean }>
  >`
    select account_id as "accountId", activation_version as "activationVersion", replay
    from activate_session_tenancy_product(
      ${accountId}::uuid, ${inventory ?? digests.inventory}, ${digests.parity}, 'database-test',
      ${shared!.admin.array(["opengeni_app"])}::text[]
    )`;
}

describe("migration 0303 session tenancy product activation", () => {
  test("serializes the first canonical boundary against a greenfield setup transaction", async () => {
    if (!shared) return;
    const accountId = await account();
    const digests = await activationDigests(accountId);
    const barrier = postgres(shared.adminUrl, { max: 1, onnotice: () => undefined });
    const activationClient = postgres(shared.adminUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    const provisioningClient = postgres(shared.adminUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    let releaseBarrier: () => void = () => {};
    let barrierReady: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const barrierReadySignal = new Promise<void>((resolve) => {
      barrierReady = resolve;
    });
    const barrierTransaction = barrier.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(
          hashtextextended('tenancy-cutover-boundary-race-test', 0)
        )`;
      barrierReady();
      await releaseSignal;
    });
    await barrierReadySignal;
    await shared.admin`
      create function tenancy_cutover_hold_activation_receipt_for_test()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
      as $body$
      begin
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('tenancy-cutover-boundary-race-test', 0)
        );
        return new;
      end
      $body$`;
    await shared.admin`
      create trigger tenancy_cutover_hold_activation_receipt_for_test
      before insert on session_tenancy_activations
      for each row execute function tenancy_cutover_hold_activation_receipt_for_test()`;

    let activationSettled = false;
    let provisioningSettled = false;
    let activationPromise: Promise<
      postgres.RowList<Array<{ accountId: string; activationVersion: number; replay: boolean }>>
    > | null = null;
    let provisioningPromise: Promise<boolean> | null = null;
    try {
      activationPromise = activationClient<
        Array<{ accountId: string; activationVersion: number; replay: boolean }>
      >`
        select account_id as "accountId", activation_version as "activationVersion", replay
        from activate_session_tenancy_product(
          ${accountId}::uuid, ${digests.inventory}, ${digests.parity}, 'boundary-race-test',
          ARRAY['opengeni_app']::text[]
        )`.then((rows) => {
        activationSettled = true;
        return rows;
      });

      let boundaryHeld = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [probe] = await shared.admin<{ acquired: boolean }[]>`
          select pg_try_advisory_xact_lock(
            hashtextextended('session-tenancy-canonical-boundary:v1', 0)
          ) as acquired`;
        if (probe?.acquired === false) {
          boundaryHeld = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(boundaryHeld).toBe(true);
      expect(activationSettled).toBe(false);

      let provisioningStarted: () => void = () => {};
      const provisioningStartedSignal = new Promise<void>((resolve) => {
        provisioningStarted = resolve;
      });
      provisioningPromise = provisioningClient
        .begin(async (transaction) => {
          // New-account lifecycle triggers may reach relations held by the
          // cutover before the account INSERT returns. Signal before that
          // boundary so this test still proves the setup transaction is
          // serialized rather than deadlocking its own release barrier.
          provisioningStarted();
          const [organization] = await transaction<{ id: string }[]>`
          insert into managed_accounts (name)
          values ('greenfield boundary race') returning id`;
          await transaction`
          insert into workspaces (account_id, name, external_source, external_id)
          values (
            ${organization!.id}, 'Personal workspace',
            'opengeni:organization-membership',
            ${`${organization!.id}:user:greenfield-boundary-race`}
          )`;
          await transaction`select lock_session_tenancy_activation_boundary()`;
          const [boundary] = await transaction<{ activated: boolean }[]>`
          select session_tenancy_any_product_activation() as activated`;
          return boundary!.activated;
        })
        .then((activated) => {
          provisioningSettled = true;
          return activated;
        });
      await provisioningStartedSignal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(provisioningSettled).toBe(false);

      releaseBarrier();
      expect(Array.from(await activationPromise)).toEqual([
        { accountId, activationVersion: 1, replay: false },
      ]);
      expect(await provisioningPromise).toBe(true);
    } finally {
      releaseBarrier();
      const pending: Promise<unknown>[] = [barrierTransaction];
      if (activationPromise) pending.push(activationPromise);
      if (provisioningPromise) pending.push(provisioningPromise);
      await Promise.allSettled(pending);
      await shared.admin`
        drop trigger if exists tenancy_cutover_hold_activation_receipt_for_test
        on session_tenancy_activations`;
      await shared.admin`drop function if exists tenancy_cutover_hold_activation_receipt_for_test()`;
      await Promise.all([barrier.end(), activationClient.end(), provisioningClient.end()]);
    }
  }, 180_000);

  test("refuses a new activation until all six current receipt families are settled", async () => {
    if (!shared) return;
    const accountId = await account({ withEvidence: false });
    let missingFailure: unknown;
    try {
      await activate(accountId);
    } catch (error) {
      missingFailure = error;
    }
    expect(nestedPostgresSqlState(missingFailure)).toBe("55000");
    expect(String(missingFailure)).toContain("requires settled backfill evidence");

    const receiptIds = await settleBackfillEvidence(accountId);
    let changedEvidenceFailure: unknown;
    try {
      await activate(accountId, "0".repeat(64));
    } catch (error) {
      changedEvidenceFailure = error;
    }
    expect(nestedPostgresSqlState(changedEvidenceFailure)).toBe("40001");
    expect(Array.from(await activate(accountId))).toEqual([
      { accountId, activationVersion: 1, replay: false },
    ]);
    const [receipt] = await shared.admin<{ backfillReceiptIds: string[] }[]>`
      select backfill_receipt_ids as "backfillReceiptIds"
      from session_tenancy_activations where account_id = ${accountId}`;
    expect(receipt?.backfillReceiptIds).toEqual(receiptIds);
  });

  test("exposes the mandatory lifecycle signatures plus the rolling fork overload", async () => {
    if (!shared) return;
    const routines = await shared.admin<
      Array<{
        name: string;
        argumentCount: number;
        defaultCount: number;
        runtimeExecutable: boolean;
      }>
    >`
      select procedure.proname as name,
        procedure.pronargs::integer as "argumentCount",
        procedure.pronargdefaults::integer as "defaultCount",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "runtimeExecutable"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = current_schema()
        and procedure.proname in (
          'transition_session_visibility',
          'fork_session_content',
          'replay_applied_session_fork'
        )
      order by procedure.proname, procedure.pronargs
    `;
    expect(Array.from(routines)).toEqual([
      {
        name: "fork_session_content",
        argumentCount: 9,
        defaultCount: 0,
        runtimeExecutable: true,
      },
      {
        name: "fork_session_content",
        argumentCount: 10,
        defaultCount: 0,
        runtimeExecutable: true,
      },
      {
        name: "replay_applied_session_fork",
        argumentCount: 10,
        defaultCount: 0,
        runtimeExecutable: true,
      },
      {
        name: "transition_session_visibility",
        argumentCount: 9,
        defaultCount: 0,
        runtimeExecutable: true,
      },
    ]);

    const [signatures] = await shared.admin<
      Array<{
        legacyTransitionAbsent: boolean;
        versionedTransitionPresent: boolean;
        legacyForkAbsent: boolean;
        versionedForkPresent: boolean;
        atomicForkPresent: boolean;
        appliedForkReplayPresent: boolean;
      }>
    >`
      select
        to_regprocedure(
          'transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text)'
        ) is null as "legacyTransitionAbsent",
        to_regprocedure(
          'transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)'
        ) is not null as "versionedTransitionPresent",
        to_regprocedure(
          'fork_session_content(uuid,uuid,uuid,text,uuid,text,text,text)'
        ) is null as "legacyForkAbsent",
        to_regprocedure(
          'fork_session_content(uuid,uuid,uuid,text,uuid,text,text,text,integer)'
        ) is not null as "versionedForkPresent",
        to_regprocedure(
          'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'
        ) is not null as "atomicForkPresent",
        to_regprocedure(
          'replay_applied_session_fork(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'
        ) is not null as "appliedForkReplayPresent"
    `;
    expect(signatures).toEqual({
      legacyTransitionAbsent: true,
      versionedTransitionPresent: true,
      legacyForkAbsent: true,
      versionedForkPresent: true,
      atomicForkPresent: true,
      appliedForkReplayPresent: true,
    });
  });

  test("enumerates every nonquiescent authority lane without stale auto-cancellation", async () => {
    const migration = await readFile(
      new URL("../drizzle/0303_session_tenancy_product_activation.sql", import.meta.url),
      "utf8",
    );
    for (const blocker of [
      "nonterminal_turn",
      "nonterminal_attempt",
      "unsettled_interruption",
      "pending_system_update",
      "pending_human_input",
      "pending_tool_receipt",
      "run_state",
      "active_goal",
      "capacity_waiter",
      "active_realtime",
      "active_scheduled_task",
      "workspace_mutation_admission",
      "retained_process",
      "active_sandbox_access",
      "shared_sandbox_group",
    ]) {
      expect(migration).toContain(`blocker := '${blocker}'`);
    }
    expect(migration).not.toContain("cancel_reason = 'authority_changed'");
    expect(migration).not.toContain("INSERT INTO workflow_wake_outbox");
  });

  test("requires an exact application-role drain", async () => {
    if (!shared) return;
    const accountId = await account();
    const app = postgres(shared.appUrl, { max: 1 });
    await app`select 1`;
    let failure: unknown;
    try {
      await activate(accountId);
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("55000");
    await app.end();
    let liveAppSessions = 1;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [drain] = await shared.admin<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and usename = 'opengeni_app'`;
      liveAppSessions = drain?.count ?? 1;
      if (liveAppSessions === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(liveAppSessions).toBe(0);
    expect(Array.from(await activate(accountId))).toEqual([
      { accountId, activationVersion: 1, replay: false },
    ]);
  });

  test("concurrent identical requests converge and changed evidence conflicts", async () => {
    if (!shared) return;
    const accountId = await account();
    const results = await Promise.all([activate(accountId), activate(accountId)]);
    expect(
      results
        .flat()
        .map((row) => row.replay)
        .sort(),
    ).toEqual([false, true]);
    let failure: unknown;
    try {
      await activate(accountId, "2".repeat(64));
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("23505");
  });

  test("exposes only value-free activation predicates to the runtime role", async () => {
    if (!shared) return;
    const accountId = await account();
    await activate(accountId);
    const runtime = createDb(shared.appUrl, { max: 1 });
    await expect(
      assertRuntimeDatabasePosture(runtime.db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
        targetSchema: "public",
      }),
    ).rejects.toThrow(/session-tenancy product activation is durable/);
    await expect(
      assertRuntimeDatabasePosture(runtime.db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
        targetSchema: "public",
        organizationTenancyCanonicalActivationEnabled: true,
      }),
    ).resolves.toBeDefined();
    await expect(
      assertRuntimeDatabasePosture(runtime.db, {
        rlsStrategy: "scoped",
        targetSchema: "public",
      }),
    ).rejects.toThrow(/session-tenancy product activation is durable/);
    await expect(
      assertRuntimeDatabasePosture(runtime.db, {
        rlsStrategy: "scoped",
        targetSchema: "public",
        organizationTenancyCanonicalActivationEnabled: true,
      }),
    ).resolves.toBeDefined();
    await runtime.close();
    const app = postgres(shared.appUrl, { max: 1 });
    try {
      const [any] = await app<{ activated: boolean }[]>`
        select session_tenancy_any_product_activation() as activated`;
      const [exact] = await app<{ activated: boolean }[]>`
        select session_tenancy_product_activated(${accountId}::uuid, 1) as activated`;
      expect(any?.activated).toBe(true);
      expect(exact?.activated).toBe(false);
      const [scopedExact] = await app.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
        return await transaction<{ activated: boolean }[]>`
          select session_tenancy_product_activated(${accountId}::uuid, 1) as activated`;
      });
      expect(scopedExact?.activated).toBe(true);
      expect(Array.from(await app`select * from session_tenancy_activations`)).toEqual([]);
      const [helperAcl] = await app<{ executable: boolean }[]>`
        select has_function_privilege(
          current_user,
          'assert_session_tenancy_quiescent(uuid,uuid,uuid,boolean)',
          'EXECUTE'
        ) as executable`;
      expect(helperAcl?.executable).toBe(false);
    } finally {
      await app.end();
    }
  });
});
