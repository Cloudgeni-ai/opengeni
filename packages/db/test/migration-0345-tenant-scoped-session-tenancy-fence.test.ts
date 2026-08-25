import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "../../testing/src/shared-pg";
import { migrate } from "../src/migrate";
import {
  canonicalSessionVisibilityTransitionHash,
  createDb,
  createSessionWithIdempotencyKeyResult,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

const migrationUrl = new URL(
  "../drizzle/0345_tenant_scoped_session_tenancy_fence.sql",
  import.meta.url,
);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

const hotTableNames = [
  "sessions",
  "session_turns",
  "session_turn_attempts",
  "session_attempt_interruptions",
  "session_system_updates",
  "session_human_input_requests",
  "session_pending_tool_calls",
  "agent_run_states",
  "session_goals",
  "codex_capacity_waiters",
  "xai_capacity_waiters",
  "session_realtime_modes",
  "session_realtime_connections",
  "scheduled_tasks",
  "sandbox_workspace_mutation_admissions",
  "sandbox_retained_processes",
  "sandbox_lease_holders",
] as const;

const hotMutationPattern = String.raw`\m(INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM)[[:space:]]+(("[^"]+"|[a-z_][a-z0-9_]*|%[0-9]+\$I)\.)?(sessions|session_turns|session_turn_attempts|session_attempt_interruptions|session_system_updates|session_human_input_requests|session_pending_tool_calls|agent_run_states|session_goals|codex_capacity_waiters|xai_capacity_waiters|session_realtime_modes|session_realtime_connections|scheduled_tasks|sandbox_workspace_mutation_admissions|sandbox_retained_processes|sandbox_lease_holders)\M`;

const directHotMutatorInventory = [
  "accept_turn_personal_resource_attachment(uuid,uuid,uuid,uuid,text,integer,boolean,integer)",
  "backfill_organization_session_ownership(uuid,integer,boolean,text)",
  "detach_scoped_machine_dependent_sessions(uuid,uuid,uuid)",
  "finalize_organization_retention_deletion(uuid,uuid,uuid,text)",
  "fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)",
  "materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)",
  "materialize_scheduled_task_reusable_session_from_run_0252(uuid,uuid,uuid,uuid,uuid,bigint,text)",
  "opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)",
  "opengeni_private.configure_fork_session_runtime(uuid,uuid,uuid,uuid,text,jsonb,uuid,uuid,text)",
  "opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)",
  "opengeni_private.reap_stale_interaction_transitions(bigint)",
  "opengeni_private.request_due_sandbox_rotations(bigint,integer)",
  "organization_membership_command(jsonb)",
  "organization_membership_command_0263(jsonb)",
  "transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)",
  "workspace_membership_removal_command(jsonb)",
] as const;

const internalHotMutatorCallers = new Map<string, string>([
  [
    "materialize_scheduled_task_reusable_session_from_run_0252(uuid,uuid,uuid,uuid,uuid,bigint,text)",
    "materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)",
  ],
  ["organization_membership_command_0263(jsonb)", "organization_membership_command(jsonb)"],
]);

const selfFencedInternalHotMutators = new Set<string>([
  "opengeni_private.configure_fork_session_runtime(uuid,uuid,uuid,uuid,text,jsonb,uuid,uuid,text)",
]);

const firstFenceIndex = (source: string): number => {
  const markers = [
    "acquire_session_tenancy_fence",
    "acquire_sandbox_reaper_session_tenancy_fences",
    "acquire_due_retained_process_session_tenancy_fences",
    "acquire_due_sandbox_rotation_session_tenancy_fences",
    "acquire_scoped_machine_session_tenancy_fences",
    "acquire_organization_session_tenancy_fences",
    "'session-tenancy:'",
  ];
  return markers.reduce((first, marker) => {
    const index = source.indexOf(marker);
    return index >= 0 && (first < 0 || index < first) ? index : first;
  }, -1);
};

const firstRowLockOrHotMutationIndex = (source: string): number => {
  const executableSource = source
    .replace(/--[^\n]*/gu, (comment) => " ".repeat(comment.length))
    .replace(/'(?:''|[^'])*'/gu, (literal) => " ".repeat(literal.length));
  return executableSource.search(
    /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b|\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(?:"[^"]+"|[a-z_][a-z0-9_]*|%[0-9]+\$I)\.)?(?:sessions|session_turns|session_turn_attempts|session_attempt_interruptions|session_system_updates|session_human_input_requests|session_pending_tool_calls|agent_run_states|session_goals|codex_capacity_waiters|xai_capacity_waiters|session_realtime_modes|session_realtime_connections|scheduled_tasks|sandbox_workspace_mutation_admissions|sandbox_retained_processes|sandbox_lease_holders)\b/iu,
  );
};

describe("migration 0345 tenant-scoped session-tenancy fence", () => {
  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("session-tenancy-fence");
    if (!owned) {
      if (requireRealDatabase) throw new Error("real database required but unavailable");
      return;
    }
    await migrate(owned.ownerUrl);
    client = createDb(owned.ownerUrl, { max: 4 });
  }, 900_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await owned?.release();
  });

  test("replaces schema-wide table locks with the canonical tenant prefix", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).not.toMatch(/LOCK TABLE/u);
    expect(migration).toContain("CREATE OR REPLACE FUNCTION assert_session_tenancy_quiescent");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION transition_session_visibility");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION fork_session_content");
    expect(migration).toContain("require_session_tenancy_fence");
    expect(migration).toContain("never restart a pre-0345 image");
    const hotTableDeclaration = migration.slice(
      migration.indexOf("hot_tables constant text[]"),
      migration.indexOf("];", migration.indexOf("hot_tables constant text[]")),
    );
    expect(hotTableDeclaration.match(/'[^']+'/gu)).toHaveLength(17);

    const transition = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION transition_session_visibility"),
      migration.indexOf("CREATE OR REPLACE FUNCTION fork_session_content"),
    );
    expect(transition.indexOf("organization-membership:")).toBeLessThan(
      transition.indexOf("session-tenancy:"),
    );
    expect(transition.indexOf("session-tenancy:")).toBeLessThan(
      transition.indexOf("FROM workspaces"),
    );
    if (owned) {
      const [installed] = await owned.admin<
        Array<{ count: number; guardCount: number; source: string }>
      >`
        select count(*)::int as count,
          count(*) filter (
            where procedure.proname = 'require_session_tenancy_fence'
          )::int as "guardCount",
          min(procedure.prosrc) as source
        from pg_trigger trigger_value
        join pg_proc procedure on procedure.oid = trigger_value.tgfoid
        join pg_class relation on relation.oid = trigger_value.tgrelid
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where trigger_value.tgname = 'session_tenancy_workspace_fence'
          and not trigger_value.tgisinternal
          and namespace.nspname = current_schema()`;
      expect(installed?.count).toBe(hotTableNames.length);
      expect(installed?.guardCount).toBe(hotTableNames.length);
      // Trigger-return definers are excluded from the callable-routine
      // inventory below. They cannot hide the login identity: SECURITY DEFINER
      // changes current_user, while this row guard deliberately checks
      // session_user and the caller backend's already-held advisory locks.
      expect(installed?.source).toContain("rolname = session_user");
      expect(installed?.source).toContain("FROM pg_locks held");
    }
  });

  test("the application activity boundary takes the matching shared prefix", async () => {
    const database = await readFile(new URL("../src/database.ts", import.meta.url), "utf8");
    const tenancy = await readFile(new URL("../src/session-tenancy.ts", import.meta.url), "utf8");
    const agents = await readFile(new URL("../../../AGENTS.md", import.meta.url), "utf8");
    expect(database).toContain("pg_advisory_xact_lock_shared");
    expect(database).toContain("session-tenancy:${context.workspaceId}");
    expect(tenancy).toMatch(/transitionSessionVisibility[\s\S]*?undefined,\s*"none"/u);
    expect(agents).toContain("never restart a pre-0345 image");
  });

  test("the cross-workspace sandbox reaper enters shared fences before row locks", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("acquire_sandbox_reaper_session_tenancy_fences");
    expect(migration).toMatch(
      /SELECT DISTINCT lease\.workspace_id[\s\S]*ORDER BY lease\.workspace_id[\s\S]*acquire_session_tenancy_fence/u,
    );
    expect(migration).toContain("0345 interaction reaper definition drift");
    expect(migration).toContain("0345 lease reaper definition drift");
    if (owned) {
      const functions = await owned.admin<Array<{ name: string; source: string }>>`
        select proc.proname as name, proc.prosrc as source
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        where namespace.nspname = 'opengeni_private'
          and proc.proname in (
            'reap_stale_interaction_transitions',
            'reap_sandbox_leases'
          )
          and pg_catalog.oidvectortypes(proc.proargtypes) in (
            'bigint',
            'bigint, bigint, bigint, bigint'
          )
        order by proc.proname`;
      expect(functions).toHaveLength(2);
      for (const installed of functions) {
        const fence = installed.source.indexOf("acquire_sandbox_reaper_session_tenancy_fences");
        const fencedAccess = installed.source.indexOf("open_session_tenancy_fenced_access");
        const firstRowLock = installed.source.indexOf("SELECT coalesce");
        expect(fence, installed.name).toBeGreaterThanOrEqual(0);
        expect(fencedAccess, installed.name).toBeGreaterThan(fence);
        expect(fencedAccess, installed.name).toBeLessThan(firstRowLock);
        if (installed.name === "reap_sandbox_leases") {
          expect(fence).toBeLessThan(
            installed.source.indexOf("set_config('opengeni.sandbox_recovery_protocol_v2'"),
          );
        } else {
          expect(installed.source.indexOf("IF p_interaction_holder_ttl_ms <= 0")).toBeLessThan(
            fence,
          );
        }
      }
    }
  });

  test("fails closed when any fenced-access repair anchor or terminal tail drifts", async () => {
    const driftOwned = await acquireOwnerMigratedTestDatabase("session-fence-definition-drift");
    if (!driftOwned) {
      if (requireRealDatabase) throw new Error("definition-drift database unavailable");
      return;
    }
    const setup = postgres(driftOwned.ownerUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      await setup.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        );
        insert into schema_migrations(name)
        values ('0345_tenant_scoped_session_tenancy_fence.sql')
      `);
      await migrate(driftOwned.ownerUrl);
      const migration = await readFile(migrationUrl, "utf8");
      const blockStart = migration.indexOf("DO $repair_owner_fenced_access_scopes$");
      const blockTerminator = "$repair_owner_fenced_access_scopes$;";
      const blockEnd = migration.indexOf(blockTerminator, blockStart);
      if (blockStart < 0 || blockEnd < 0) {
        throw new Error("fenced-access repair block not found");
      }
      const repairPrefix = migration.slice(0, blockStart);
      const repairBlock = migration.slice(0 + blockStart, blockEnd + blockTerminator.length);
      await setup.unsafe("set search_path = public, opengeni_private");
      await setup.unsafe(repairPrefix);

      const expectDefinitionDrift = async (
        signature: string,
        mutate: (definition: string) => string,
        expectedMessage: string,
      ) => {
        let driftError: unknown;
        const rollbackMarker = new Error("rollback definition-drift fixture");
        try {
          await setup.begin(async (transaction) => {
            const [installed] = await transaction<Array<{ definition: string }>>`
              select pg_get_functiondef(to_regprocedure(${signature})) as definition`;
            if (!installed?.definition) throw new Error(`missing fixture routine ${signature}`);
            const drifted = mutate(installed.definition);
            if (drifted === installed.definition) {
              throw new Error(`fixture mutation did not change ${signature}`);
            }
            await transaction.unsafe(drifted);
            try {
              await transaction.unsafe(repairBlock);
            } catch (error) {
              driftError = error;
            }
            throw rollbackMarker;
          });
        } catch (error) {
          if (error !== rollbackMarker) throw error;
        }
        expect(driftError).toMatchObject({ code: "55000" });
        expect(String(driftError)).toContain(expectedMessage);
      };

      await expectDefinitionDrift(
        "opengeni_private.reap_stale_interaction_transitions(bigint)",
        (definition) =>
          definition.replace("      RETURN settled_count;", "      RETURN settled_count + 0;"),
        "interaction reaper fenced-access normal-close anchor drift",
      );
      await expectDefinitionDrift(
        "opengeni_private.request_due_sandbox_rotations(bigint,integer)",
        (definition) => {
          const anchor =
            "      PERFORM acquire_due_sandbox_rotation_session_tenancy_fences(\n" +
            "        p_lead_ms\n" +
            "      );";
          return definition.replace(anchor, `${anchor}\n${anchor}`);
        },
        "rotation fenced-access open anchor drift",
      );
      await expectDefinitionDrift(
        "opengeni_private.reap_stale_interaction_transitions(bigint)",
        (definition) => definition.replace("    END;\n    $function$\n", "END;\n$function$\n"),
        "interaction reaper fenced-access tail drift",
      );
    } finally {
      await setup.end({ timeout: 5 }).catch(() => undefined);
      await driftOwned.release();
    }
  }, 900_000);

  test("organization membership lifecycle enters every workspace fence before row locks", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    const helper = migration.slice(
      migration.indexOf("acquire_organization_session_tenancy_fences"),
      migration.indexOf("$membership_fences$;", migration.indexOf("$membership_fences$")) +
        "$membership_fences$;".length,
    );
    expect(helper.indexOf("organization-membership:")).toBeLessThan(
      helper.indexOf("acquire_session_tenancy_fence"),
    );
    expect(helper).toMatch(
      /SELECT workspace\.id[\s\S]*ORDER BY workspace\.id[\s\S]*acquire_session_tenancy_fence/u,
    );
    expect(migration).toContain("0345 organization membership session-tenancy prefix drift");
    if (owned) {
      const functions = await owned.admin<Array<{ signature: string; source: string }>>`
        select procedure.oid::regprocedure::text as signature,
          procedure.prosrc as source
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = current_schema()
          and procedure.proname in (
            'prepare_organization_membership_protocol_settlements',
            'organization_membership_command_0263',
            'organization_membership_command'
          )
          and pg_catalog.oidvectortypes(procedure.proargtypes) = 'jsonb'
        order by procedure.proname`;
      expect(functions).toHaveLength(3);
      for (const installed of functions) {
        const organizationFence = installed.source.indexOf("organization-membership:");
        const sessionFence = installed.source.indexOf(
          "acquire_organization_session_tenancy_fences",
        );
        const firstRowLock = installed.source.indexOf("FROM managed_accounts account");
        expect(organizationFence, installed.signature).toBeGreaterThanOrEqual(0);
        expect(sessionFence, installed.signature).toBeGreaterThan(organizationFence);
        expect(firstRowLock, installed.signature).toBeGreaterThan(sessionFence);
      }
    }
  });

  test("retention finalization enters all affected workspace fences before row locks", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    const helperStart = migration.indexOf("acquire_organization_session_tenancy_fences");
    const helper = migration.slice(
      helperStart,
      migration.indexOf("$membership_fences$;", helperStart) + "$membership_fences$;".length,
    );
    expect(helper.indexOf("organization-membership:")).toBeLessThan(
      helper.indexOf("acquire_session_tenancy_fence"),
    );
    expect(migration).toContain("0345 organization retention session-tenancy prefix drift");
    if (owned) {
      const [installed] = await owned.admin<Array<{ source: string }>>`
        select procedure.prosrc as source
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = current_schema()
          and procedure.proname = 'finalize_organization_retention_deletion'
          and pg_catalog.oidvectortypes(procedure.proargtypes) = 'uuid, uuid, uuid, text'`;
      const fence = installed?.source.indexOf("acquire_organization_session_tenancy_fences");
      const firstRowLock = installed?.source.indexOf("FOR UPDATE");
      const cascade = installed?.source.indexOf("DELETE FROM workspaces workspace");
      expect(fence).toBeGreaterThanOrEqual(0);
      expect(firstRowLock).toBeGreaterThan(fence ?? Number.MAX_SAFE_INTEGER);
      expect(cascade).toBeGreaterThan(firstRowLock ?? Number.MAX_SAFE_INTEGER);
    }
  });

  test("inventories every direct SECURITY DEFINER hot-table mutator and its fence chain", async () => {
    if (!owned) return;
    const cascadeRoots = await owned.admin<Array<{ tableName: string }>>`
      with recursive hot_relations(relation_id) as (
        select relation.oid
        from unnest(${hotTableNames}::text[]) hot_table(table_name)
        join pg_class relation on relation.relname = hot_table.table_name
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = current_schema()
      ), cascade_delete_targets(relation_id) as (
        select relation_id from hot_relations
        union
        select constraint_value.confrelid
        from pg_constraint constraint_value
        join cascade_delete_targets child
          on child.relation_id = constraint_value.conrelid
        where constraint_value.contype = 'f'
          and constraint_value.confdeltype = 'c'
      )
      select relation.relname as "tableName"
      from cascade_delete_targets target
      join pg_class relation on relation.oid = target.relation_id
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = current_schema()
        and not exists (
          select 1 from hot_relations hot
          where hot.relation_id = target.relation_id
        )
      order by relation.relname`;
    expect(cascadeRoots.map((root) => root.tableName)).toEqual([
      "managed_accounts",
      "sandbox_leases",
      "workspaces",
    ]);
    const cascadeDeletePattern = String.raw`\mDELETE[[:space:]]+FROM[[:space:]]+(("[^"]+"|[a-z_][a-z0-9_]*|%[0-9]+\$I)\.)?(${cascadeRoots
      .map((root) => root.tableName)
      .join("|")})\M`;
    const inventory = await owned.admin<
      Array<{
        signature: string;
        source: string;
        appExecutable: boolean;
      }>
    >`
      select case
          when namespace.nspname = current_schema()
          then procedure.proname
          else namespace.nspname || '.' || procedure.proname
        end || '(' || replace(
          pg_catalog.oidvectortypes(procedure.proargtypes), ' ', ''
        ) || ')' as signature,
        procedure.prosrc as source,
        pg_catalog.has_function_privilege(
          'opengeni_app', procedure.oid, 'EXECUTE'
        ) as "appExecutable"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      join pg_language language on language.oid = procedure.prolang
      where procedure.prosecdef
        and procedure.prokind = 'f'
        and procedure.prorettype <> 'trigger'::regtype
        and language.lanname in ('plpgsql', 'sql')
        and namespace.nspname in (current_schema(), 'opengeni_private')
        and (
          procedure.prosrc ~* ${hotMutationPattern}
          or procedure.prosrc ~* ${cascadeDeletePattern}
        )
      order by signature`;

    expect(inventory.map((routine) => routine.signature)).toEqual(
      [...directHotMutatorInventory].sort(),
    );
    const bySignature = new Map(inventory.map((routine) => [routine.signature, routine]));

    for (const routine of inventory) {
      if (internalHotMutatorCallers.has(routine.signature)) {
        expect(routine.appExecutable, routine.signature).toBe(false);
        continue;
      }
      if (selfFencedInternalHotMutators.has(routine.signature)) {
        expect(routine.appExecutable, routine.signature).toBe(false);
      } else {
        expect(routine.appExecutable, routine.signature).toBe(true);
      }
      const fence = firstFenceIndex(routine.source);
      const protectedAction = firstRowLockOrHotMutationIndex(routine.source);
      expect(fence, routine.signature).toBeGreaterThanOrEqual(0);
      expect(protectedAction, routine.signature).toBeGreaterThan(fence);
    }

    // Internal implementations are safe only through a recursively classified
    // caller chain. This prevents a future grant or a new unclassified internal
    // caller from silently turning wrapper-local fencing back into a protocol.
    for (const [internalSignature, directCaller] of internalHotMutatorCallers) {
      let callee = bySignature.get(internalSignature);
      let callerSignature: string | undefined = directCaller;
      const visited = new Set<string>();
      while (callee && callerSignature) {
        expect(visited.has(callee.signature), callee.signature).toBe(false);
        visited.add(callee.signature);
        const caller = bySignature.get(callerSignature);
        expect(caller, `${callee.signature} caller`).toBeDefined();
        expect(caller?.source, callerSignature).toContain(
          callee.signature.slice(0, callee.signature.indexOf("(")),
        );
        if (!caller || caller.appExecutable) {
          expect(caller?.appExecutable, callerSignature).toBe(true);
          const fence = firstFenceIndex(caller?.source ?? "");
          const protectedAction = firstRowLockOrHotMutationIndex(caller?.source ?? "");
          expect(fence, callerSignature).toBeGreaterThanOrEqual(0);
          expect(protectedAction, callerSignature).toBeGreaterThan(fence);
          break;
        }
        callee = caller;
        callerSignature = internalHotMutatorCallers.get(caller.signature);
      }
      expect(callerSignature, internalSignature).toBeDefined();
    }
  });

  test("keeps an outer inventory token active when an inner open rolls back", async () => {
    if (!owned) return;
    await owned.admin.begin(async (transaction) => {
      const [installed] = await transaction<Array<{ targetSchema: number }>>`
        select session_tenancy_fence_target_schema()::int as "targetSchema"`;
      const targetSchema = installed?.targetSchema;
      if (!targetSchema) throw new Error("target schema identity was not installed");
      const [outer] = await transaction<Array<{ capabilityId: string }>>`
        select opengeni_private.open_session_tenancy_fence_inventory(
          ${targetSchema}::oid
        ) as "capabilityId"`;
      if (!outer) throw new Error("outer inventory token was not opened");

      await transaction`savepoint inner_inventory`;
      const [inner] = await transaction<Array<{ capabilityId: string }>>`
        select opengeni_private.open_session_tenancy_fence_inventory(
          ${targetSchema}::oid
        ) as "capabilityId"`;
      if (!inner) throw new Error("inner inventory token was not opened");
      await transaction`rollback to savepoint inner_inventory`;
      // This is the sequence run by an inner helper's exception handler: its
      // INSERT has already rolled back, so exact-token close must be a no-op.
      await transaction`
        select opengeni_private.close_session_tenancy_fence_inventory(
          ${inner.capabilityId}::uuid
        )`;
      const [outerSurvived] = await transaction<
        Array<{ active: boolean; rowCount: number; outerPresent: boolean }>
      >`
        select
          opengeni_private.session_tenancy_fence_inventory_capability_active(
            ${targetSchema}::oid
          ) as active,
          (select count(*)::int
            from opengeni_private.session_tenancy_fence_inventory_capabilities
            where target_schema = ${targetSchema}::oid
              and backend_pid = pg_backend_pid()
              and transaction_id = pg_current_xact_id_if_assigned()
          ) as "rowCount",
          exists (
            select 1
            from opengeni_private.session_tenancy_fence_inventory_capabilities
            where capability_id = ${outer.capabilityId}::uuid
          ) as "outerPresent"`;
      expect(outerSurvived).toEqual({ active: true, rowCount: 1, outerPresent: true });

      await transaction`
        select opengeni_private.close_session_tenancy_fence_inventory(
          ${outer.capabilityId}::uuid
        )`;
      const [closed] = await transaction<Array<{ active: boolean; rowCount: number }>>`
        select
          opengeni_private.session_tenancy_fence_inventory_capability_active(
            ${targetSchema}::oid
          ) as active,
          (select count(*)::int
            from opengeni_private.session_tenancy_fence_inventory_capabilities
            where target_schema = ${targetSchema}::oid
              and backend_pid = pg_backend_pid()
              and transaction_id = pg_current_xact_id_if_assigned()
          ) as "rowCount"`;
      expect(closed).toEqual({ active: false, rowCount: 0 });
    });
  });

  test("requires an exact fenced-access token in addition to the held workspace lock", async () => {
    if (!owned) return;
    const runtime = postgres(owned.ownerUrl, {
      max: 1,
      onnotice: () => undefined,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      await runtime.begin(async (transaction) => {
        const workspaceId = crypto.randomUUID();
        const [identity] = await transaction<Array<{ targetSchema: number }>>`
          select session_tenancy_fence_target_schema()::int as "targetSchema"`;
        if (!identity) throw new Error("target schema identity was not installed");
        await transaction`
          select pg_advisory_xact_lock_shared(hashtextextended(
            ${`session-tenancy:${workspaceId}`}, 0
          ))`;
        const evaluate = async () => {
          const [result] = await transaction<Array<{ active: boolean }>>`
            select session_tenancy_fence_owner_policy_active(
              current_user,
              ${owned!.ownerRole},
              ${identity.targetSchema}::oid,
              ${workspaceId}::uuid,
              false
            ) as active`;
          return result?.active;
        };
        expect(await evaluate()).toBe(false);
        const [opened] = await transaction<Array<{ capabilityId: string }>>`
          select opengeni_private.open_session_tenancy_fenced_access(
            ${identity.targetSchema}::oid
          ) as "capabilityId"`;
        if (!opened) throw new Error("fenced-access token was not opened");
        expect(await evaluate()).toBe(true);
        await transaction`
          select opengeni_private.close_session_tenancy_fenced_access(
            ${opened.capabilityId}::uuid
          )`;
        expect(await evaluate()).toBe(false);
      });
    } finally {
      await runtime.end({ timeout: 5 });
    }
  });

  test("an exclusive fence blocks only writers in the same workspace", async () => {
    if (!owned) return;
    const holder = postgres(owned.ownerUrl, {
      max: 1,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    const probe = postgres(owned.ownerUrl, {
      max: 1,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    const connection = await holder.reserve();
    try {
      await connection`begin`;
      await connection`select pg_advisory_xact_lock(hashtextextended(
        ${`session-tenancy:${workspaceA}`}, 0))`;
      const [same] = await probe<Array<{ acquired: boolean }>>`
        select pg_try_advisory_xact_lock_shared(hashtextextended(
          ${`session-tenancy:${workspaceA}`}, 0)) as acquired`;
      const [other] = await probe<Array<{ acquired: boolean }>>`
        select pg_try_advisory_xact_lock_shared(hashtextextended(
          ${`session-tenancy:${workspaceB}`}, 0)) as acquired`;
      expect(same?.acquired).toBe(false);
      expect(other?.acquired).toBe(true);
    } finally {
      await connection`rollback`;
      connection.release();
      await holder.end({ timeout: 5 });
      await probe.end({ timeout: 5 });
    }
  });

  test("multi-workspace and global helpers fence only their affected workspace sets", async () => {
    if (!owned || !client) return;
    const userId = `fence-set-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Fence set owner",
    });
    const membership = provisioned.organizationMemberships[0];
    const accountId = membership?.organizationId;
    const personalWorkspaceId = membership?.personalWorkspaceId;
    const sharedWorkspaceId = provisioned.accessContext.workspaceGrants.find(
      (grant) => grant.accountId === accountId && grant.workspaceId !== personalWorkspaceId,
    )?.workspaceId;
    if (!accountId || !personalWorkspaceId || !sharedWorkspaceId) {
      throw new Error("fence-set fixture requires personal and shared workspaces");
    }
    const [secondaryWorkspace] = await owned.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${accountId}, ${`Fence secondary ${crypto.randomUUID()}`})
      returning id`;
    if (!secondaryWorkspace) throw new Error("secondary workspace was not created");
    await owned.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${secondaryWorkspace.id}, ${accountId})`;

    const create = async (workspaceId: string, key: string) => {
      const result = await createSessionWithIdempotencyKeyResult(client!.db, {
        accountId,
        workspaceId,
        visibility: "workspace_shared",
        initialMessage: "workspace fence selection",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createIdempotencyKey: key,
      });
      if (result.denied) throw new Error("fence-set fixture create denied");
      return result.session;
    };
    const personalSession = await create(personalWorkspaceId, `personal-${crypto.randomUUID()}`);
    const sharedSession = await create(sharedWorkspaceId, `shared-${crypto.randomUUID()}`);
    const machineId = crypto.randomUUID();
    await owned.admin`
      update sessions set
        sandbox_group_id = ${machineId},
        sandbox_backend = 'selfhosted'
      where id in (${personalSession.id}, ${sharedSession.id})`;

    const dueLeaseId = crypto.randomUUID();
    const dueAdmissionId = crypto.randomUUID();
    const dueActorId = crypto.randomUUID();
    const processId = crypto.randomUUID();
    const processHolderId = `process-${crypto.randomUUID()}`;
    const dueInstanceId = `instance-${crypto.randomUUID()}`;
    const laterLeaseId = crypto.randomUUID();
    await owned.admin.begin(async (transaction) => {
      await transaction`
        select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
      await transaction`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness,
          refcount, turn_holders, viewer_holders, instance_id, backend,
          lease_epoch, workspace_generation, provider_created_at,
          provider_deadline_at, expires_at
        ) values (
          ${dueLeaseId}, ${accountId}, ${sharedWorkspaceId}, ${machineId}, 'warm',
          2, 0, 1, ${dueInstanceId}, 'modal',
          1, 1, now() - interval '1 hour', now() - interval '1 minute',
          now() + interval '1 hour'
        ), (
          ${laterLeaseId}, ${accountId}, ${secondaryWorkspace.id},
          ${crypto.randomUUID()}, 'warm', 1, 0, 1,
          ${`instance-${crypto.randomUUID()}`}, 'modal', 1, 1,
          now(), now() + interval '1 day', now() + interval '2 days'
        )`;
      await transaction`
        insert into sandbox_lease_holders (
          account_id, workspace_id, lease_id, kind, holder_id, subject_id
        ) values (
          ${accountId}, ${sharedWorkspaceId}, ${dueLeaseId},
          'viewer', ${`viewer-${crypto.randomUUID()}`}, ${sharedSession.id}
        ), (
          ${accountId}, ${sharedWorkspaceId}, ${dueLeaseId},
          'process', ${processHolderId}, ${sharedSession.id}
        ), (
          ${accountId}, ${secondaryWorkspace.id}, ${laterLeaseId},
          'viewer', ${`viewer-${crypto.randomUUID()}`}, null
        )`;
      await transaction`
        insert into sandbox_workspace_mutation_admissions (
          id, account_id, workspace_id, lease_id, sandbox_group_id, session_id,
          actor_kind, actor_id, holder_kind, holder_id, lease_epoch,
          provider_backend, provider_instance_id, route_kind, route_epoch,
          workspace_generation, operation, provider_outcome
        ) values (
          ${dueAdmissionId}, ${accountId}, ${sharedWorkspaceId}, ${dueLeaseId},
          ${machineId}, ${sharedSession.id}, 'direct', ${dueActorId},
          'direct', ${`direct-${crypto.randomUUID()}`}, 1,
          'modal', ${dueInstanceId}, 'home', 0, 1, 'exec', 'retained'
        )`;
      await transaction`
        insert into sandbox_retained_processes (
          id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
          parent_admission_id, holder_id, owner_actor_kind, owner_actor_id,
          lease_epoch, provider_backend, provider_instance_id, route_kind,
          route_epoch, provider_session_id, reconcile_after
        ) values (
          ${processId}, ${accountId}, ${sharedWorkspaceId}, ${sharedSession.id},
          ${dueLeaseId}, ${machineId}, ${dueAdmissionId}, ${processHolderId},
          'direct', ${dueActorId}, 1, 'modal', ${dueInstanceId}, 'home', 0, 1,
          now() - interval '1 minute'
        )`;
    });

    const assertSelection = async (
      invoke: (connection: postgres.ReservedSql) => Promise<number>,
      expectedCount: number,
      blockedWorkspaceIds: string[],
      availableWorkspaceIds: string[],
      setActorScope = true,
    ) => {
      const holder = postgres(owned!.ownerUrl, {
        max: 1,
        onnotice: () => undefined,
        connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
      });
      const probe = postgres(owned!.ownerUrl, {
        max: 1,
        onnotice: () => undefined,
        connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
      });
      const connection = await holder.reserve();
      try {
        await connection`begin`;
        if (setActorScope) {
          await connection`select set_config('opengeni.account_id', ${accountId}, true),
            set_config('opengeni.subject_id', ${subjectId}, true)`;
        }
        expect(await invoke(connection)).toBe(expectedCount);
        for (const workspaceId of blockedWorkspaceIds) {
          const [result] = await probe<Array<{ acquired: boolean }>>`
            select pg_try_advisory_xact_lock(hashtextextended(
              ${`session-tenancy:${workspaceId}`}, 0
            )) as acquired`;
          expect(result?.acquired, workspaceId).toBe(false);
        }
        for (const workspaceId of availableWorkspaceIds) {
          const [result] = await probe<Array<{ acquired: boolean }>>`
            select pg_try_advisory_xact_lock(hashtextextended(
              ${`session-tenancy:${workspaceId}`}, 0
            )) as acquired`;
          expect(result?.acquired, workspaceId).toBe(true);
        }
      } finally {
        await connection`rollback`.catch(() => undefined);
        connection.release();
        await holder.end({ timeout: 5 });
        await probe.end({ timeout: 5 });
      }
    };

    const organizationWorkspaceIds = await owned.admin<Array<{ id: string }>>`
      select id from workspaces where account_id = ${accountId} order by id`;
    await assertSelection(
      async (connection) => {
        const [row] = await connection<Array<{ count: number }>>`
          select acquire_organization_session_tenancy_fences(
            ${accountId}
          ) as count`;
        return row?.count ?? -1;
      },
      organizationWorkspaceIds.length,
      organizationWorkspaceIds.map((workspace) => workspace.id),
      [],
    );
    await assertSelection(
      async (connection) => {
        await connection`
          insert into opengeni_private.scoped_compute_capabilities (
            backend_pid, transaction_id, capability_kind
          ) values (pg_backend_pid(), pg_current_xact_id(), 'write')
          on conflict do nothing`;
        await connection`
          select set_config('opengeni.subject_id', 'user:hostile-inventory-scope', true)`;
        const [row] = await connection<Array<{ count: number }>>`
          select acquire_scoped_machine_session_tenancy_fences(
            ${accountId}, ${machineId}
          ) as count`;
        return row?.count ?? -1;
      },
      2,
      [personalWorkspaceId, sharedWorkspaceId],
      [secondaryWorkspace.id],
    );
    await assertSelection(
      async (connection) => {
        const [row] = await connection<Array<{ count: number }>>`
          select acquire_due_sandbox_rotation_session_tenancy_fences(0)
            as count`;
        return row?.count ?? -1;
      },
      1,
      [sharedWorkspaceId],
      [secondaryWorkspace.id],
      false,
    );
    await assertSelection(
      async (connection) => {
        const [row] = await connection<Array<{ count: number }>>`
          select acquire_due_retained_process_session_tenancy_fences()
            as count`;
        return row?.count ?? -1;
      },
      1,
      [sharedWorkspaceId],
      [secondaryWorkspace.id],
      false,
    );

    const runtimeUrl = new URL(owned.adminUrl);
    runtimeUrl.username = "opengeni_app";
    runtimeUrl.password = owned.appPassword;
    const runtime = postgres(runtimeUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      await runtime.begin(async (transaction) => {
        await transaction`
          select set_config('opengeni.subject_id', 'user:hostile-global-scope', true),
            set_config('opengeni.account_id', ${crypto.randomUUID()}, true),
            set_config('opengeni.workspace_id', ${crypto.randomUUID()}, true)`;
        const [rotation] = await transaction<Array<{ requested: number }>>`
          select opengeni_private.request_due_sandbox_rotations(0, 1) as requested`;
        expect(rotation?.requested).toBe(1);
        const claims = await transaction<Array<{ processId: string; claimId: string }>>`
          select process_id as "processId", claim_id as "claimId"
          from opengeni_private.claim_terminal_retained_processes(
            ${crypto.randomUUID()}, 1, 60000
          )`;
        expect(claims).toHaveLength(1);
        expect(claims[0]?.processId).toBe(processId);
        expect(claims[0]?.claimId).toBeTruthy();
      });
      const [bounded] = await owned.admin<
        Array<{
          laterRequested: boolean;
          inventoryCapabilities: number;
          fencedAccessCapabilities: number;
        }>
      >`
        select
          (select rotation_requested_at is not null from sandbox_leases
            where id = ${laterLeaseId}) as "laterRequested",
          (select count(*)::int
            from opengeni_private.session_tenancy_fence_inventory_capabilities)
            as "inventoryCapabilities",
          (select count(*)::int
            from opengeni_private.session_tenancy_fenced_access_capabilities)
            as "fencedAccessCapabilities"`;
      expect(bounded).toEqual({
        laterRequested: false,
        inventoryCapabilities: 0,
        fencedAccessCapabilities: 0,
      });
    } finally {
      await runtime.end({ timeout: 5 });
    }
  }, 900_000);

  test("a real transition fences same-workspace production writes but not another workspace", async () => {
    if (!owned || !client) return;
    const within = async <T>(operation: Promise<T>, label: string): Promise<T> =>
      await Promise.race([
        operation,
        Bun.sleep(10_000).then(() => {
          throw new Error(`${label} exceeded 10s`);
        }),
      ]);
    const userId = `fence-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await within(
      ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Fence owner",
      }),
      "managed-access provisioning",
    );
    const personalWorkspaceId = provisioned.organizationMemberships[0]?.personalWorkspaceId;
    const sharedGrant = provisioned.accessContext.workspaceGrants.find(
      (candidate) => candidate.workspaceId !== personalWorkspaceId,
    );
    const sharedWorkspaceId = sharedGrant?.workspaceId;
    const grant = provisioned.accessContext.workspaceGrants.find(
      (candidate) => candidate.workspaceId === sharedWorkspaceId,
    );
    const membership = provisioned.organizationMemberships.find(
      (candidate) => candidate.organizationId === grant?.accountId,
    );
    if (!grant || !membership?.personalWorkspaceId || !sharedWorkspaceId) {
      throw new Error("fence fixture requires distinct shared and personal workspaces");
    }
    await within(
      owned.admin`update organization_memberships set role = 'owner' where id = ${membership.id}`,
      "owner-role fixture update",
    );
    await within(
      owned.admin`insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${grant.accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, '0345-test')`,
      "tenancy-activation fixture insert",
    );

    // A personal workspace owned by the same subject legitimately shares the
    // organization-membership authority row that the transition locks. Use a
    // second organization/subject here so the assertion isolates the tenancy
    // fence itself from that independent lifecycle serialization boundary.
    const otherUserId = `fence-other-${crypto.randomUUID()}`;
    const otherSubjectId = `user:${otherUserId}`;
    const otherProvisioned = await within(
      ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
        userId: otherUserId,
        email: `${otherUserId}@example.test`,
        name: "Other fence owner",
      }),
      "other-tenant managed-access provisioning",
    );
    const otherWorkspaceId = otherProvisioned.accessContext.defaultWorkspaceId;
    const otherGrant = otherProvisioned.accessContext.workspaceGrants.find(
      (candidate) => candidate.workspaceId === otherWorkspaceId,
    );
    if (!otherWorkspaceId || !otherGrant || otherGrant.accountId === grant.accountId) {
      throw new Error("fence fixture requires an unrelated organization workspace");
    }

    const create = async (
      accountId: string,
      workspaceId: string,
      actorSubjectId: string,
      key: string,
    ) => {
      const result = await createSessionWithIdempotencyKeyResult(client!.db, {
        accountId,
        workspaceId,
        visibility: "workspace_shared",
        initialMessage: "tenant fence",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: actorSubjectId },
        subjectId: actorSubjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createIdempotencyKey: key,
      });
      if (result.denied) throw new Error("fence fixture create denied");
      return result.session;
    };
    const source = await within(
      create(grant.accountId, sharedWorkspaceId, subjectId, `source-${crypto.randomUUID()}`),
      "source production writer",
    );
    const holder = postgres(owned.ownerUrl, {
      max: 1,
      onnotice: () => undefined,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    const connection = await holder.reserve();
    try {
      await connection`begin`;
      await connection`select set_config('opengeni.account_id', ${grant.accountId}, true),
        set_config('opengeni.workspace_id', ${sharedWorkspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true),
        set_config('lock_timeout', '10s', true),
        set_config('statement_timeout', '10s', true)`;
      const operationKey = `hold-${crypto.randomUUID()}`;
      const requestHash = canonicalSessionVisibilityTransitionHash({
        sessionId: source.id,
        targetVisibility: "workspace_shared",
        expectedAuthorityEpoch: 1,
      });
      await within(
        connection`select * from transition_session_visibility(
          ${grant.accountId}::uuid, ${sharedWorkspaceId}::uuid, ${source.id}::uuid,
          ${subjectId}, 'workspace_shared', 1, ${operationKey}, ${requestHash}, 1)`,
        "exclusive transition fence",
      );

      const same = create(
        grant.accountId,
        sharedWorkspaceId,
        subjectId,
        `same-${crypto.randomUUID()}`,
      );
      const other = create(
        otherGrant.accountId,
        otherWorkspaceId,
        otherSubjectId,
        `other-${crypto.randomUUID()}`,
      );
      const pending = Symbol("pending");
      expect(
        await Promise.race([same.then(() => "settled"), Bun.sleep(250).then(() => pending)]),
      ).toBe(pending);
      await expect(within(other, "other-workspace production writer")).resolves.toHaveProperty(
        "workspaceId",
        otherWorkspaceId,
      );
      await connection`commit`;
      await expect(within(same, "same-workspace production writer")).resolves.toHaveProperty(
        "workspaceId",
        sharedWorkspaceId,
      );
    } finally {
      await connection`rollback`.catch(() => undefined);
      connection.release();
      await holder.end({ timeout: 5 });
    }
  }, 900_000);

  test("binds one target schema and rejects a second before any catalog mutation", async () => {
    if (!owned) return;
    const primaryOwned = owned;
    const isolated = await acquireOwnerMigratedTestDatabase("session-fence-target-registry");
    if (!isolated) {
      if (requireRealDatabase) throw new Error("target-registry real database unavailable");
      return;
    }
    owned = isolated;
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const targetA = `fence_target_a_${suffix}`;
    const targetB = `fence_target_b_${suffix}`;
    const runtimeRole = `fence_runtime_${suffix}`;
    await owned.admin.unsafe(
      `CREATE ROLE "${runtimeRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
    );
    try {
      const ownerSetup = postgres(owned.ownerUrl, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      const migration0345 = await readFile(migrationUrl, "utf8");
      const pre0345Files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql") && file < "0345_")
        .sort();
      const globalRoutineSignatures = [
        "opengeni_private.reap_stale_interaction_transitions(bigint)",
        "opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)",
        "opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)",
        "opengeni_private.request_due_sandbox_rotations(bigint,integer)",
      ];
      const sharedCapabilitySignatures = [
        "opengeni_private.session_tenancy_fence_inventory_capability_active(oid)",
        "opengeni_private.open_session_tenancy_fence_inventory(oid)",
        "opengeni_private.close_session_tenancy_fence_inventory(uuid)",
        "opengeni_private.session_tenancy_fenced_access_capability_active(oid)",
        "opengeni_private.open_session_tenancy_fenced_access(oid)",
        "opengeni_private.close_session_tenancy_fenced_access(uuid)",
      ];
      const apply0345Once = async (targetSchema: string): Promise<boolean> => {
        const [applied] = await ownerSetup.unsafe<Array<{ applied: boolean }>>(
          `select exists (
            select 1 from "${targetSchema}".schema_migrations
            where name = '0345_tenant_scoped_session_tenancy_fence.sql'
          ) as applied`,
        );
        if (applied?.applied) return false;
        await ownerSetup.unsafe(`SET search_path = "${targetSchema}", opengeni_private, public`);
        await ownerSetup.unsafe(migration0345);
        await ownerSetup.unsafe(
          `insert into "${targetSchema}".schema_migrations(name)
           values ('0345_tenant_scoped_session_tenancy_fence.sql')`,
        );
        return true;
      };
      const snapshotSharedFunctions = async () => {
        await ownerSetup.unsafe(`SET search_path = "${targetA}", opengeni_private, public`);
        return await ownerSetup<
          Array<{
            signature: string;
            definition: string;
            settings: string[] | null;
            owner: string;
            acl: string | null;
          }>
        >`
          select procedure.oid::regprocedure::text as signature,
            pg_get_functiondef(procedure.oid) as definition,
            procedure.proconfig as settings,
            pg_get_userbyid(procedure.proowner) as owner,
            procedure.proacl::text as acl
          from pg_proc procedure
          join pg_namespace namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'opengeni_private'
          order by procedure.oid::regprocedure::text`;
      };
      const snapshotTargetObjects = async (targetSchema: string) => {
        await ownerSetup.unsafe(`SET search_path = "${targetSchema}", opengeni_private, public`);
        return await ownerSetup<Array<{ kind: string; identity: string; definition: string }>>`
          select 'function' as kind,
            procedure.oid::regprocedure::text as identity,
            pg_get_functiondef(procedure.oid) as definition
          from pg_proc procedure
          join pg_namespace namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = ${targetSchema}
          union all
          select 'relation', relation.relname,
            concat_ws(':', relation.oid::text, relation.relkind::text,
              pg_get_userbyid(relation.relowner), relation.relacl::text,
              relation.relrowsecurity::text, relation.relforcerowsecurity::text)
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = ${targetSchema}
          union all
          select 'constraint', constraint_value.conname,
            pg_get_constraintdef(constraint_value.oid, false)
          from pg_constraint constraint_value
          join pg_namespace namespace on namespace.oid = constraint_value.connamespace
          where namespace.nspname = ${targetSchema}
          union all
          select 'policy', policy.polname,
            concat_ws(':', policy.polcmd, policy.polpermissive::text,
              pg_get_expr(policy.polqual, policy.polrelid),
              pg_get_expr(policy.polwithcheck, policy.polrelid))
          from pg_policy policy
          join pg_class relation on relation.oid = policy.polrelid
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = ${targetSchema}
          union all
          select 'trigger', trigger.tgname, pg_get_triggerdef(trigger.oid, false)
          from pg_trigger trigger
          join pg_class relation on relation.oid = trigger.tgrelid
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = ${targetSchema} and not trigger.tgisinternal
          order by kind, identity`;
      };
      try {
        await ownerSetup.unsafe(
          `CREATE SCHEMA "${targetA}";
           CREATE SCHEMA IF NOT EXISTS opengeni_private;
           SET search_path = "${targetA}", opengeni_private, public;
           CREATE TABLE "${targetA}".schema_migrations (
             name text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           );
           SELECT set_config(
             'opengeni.migration_application_roles',
             '${JSON.stringify([runtimeRole])}',
             false
           )`,
        );
        for (const file of pre0345Files) {
          const sql = await readFile(join(migrationsDir, file), "utf8");
          if (sql.includes("opengeni:concurrent-index")) {
            await ownerSetup.unsafe(
              sql
                .split("\n")
                .filter((line) => !line.trimStart().startsWith("--"))
                .join("\n"),
            );
          } else {
            await ownerSetup.unsafe(sql);
          }
          await ownerSetup`
            insert into ${ownerSetup(targetA)}.schema_migrations(name)
            values (${file})`;
        }
        expect(await apply0345Once(targetA)).toBe(true);

        await ownerSetup.unsafe(
          `CREATE SCHEMA "${targetB}";
           CREATE TABLE "${targetB}".schema_migrations (
             name text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           );
           CREATE TABLE "${targetB}".sentinel (id integer PRIMARY KEY);
           CREATE FUNCTION "${targetB}".sentinel_function() RETURNS integer
             LANGUAGE sql IMMUTABLE AS 'SELECT 1'`,
        );

        const sharedBeforeReplay = await snapshotSharedFunctions();
        expect(await apply0345Once(targetA)).toBe(false);
        expect(await snapshotSharedFunctions()).toEqual(sharedBeforeReplay);

        // Replaying the registry prefix itself for the bound target is safe.
        const registryPrefix = migration0345.slice(
          0,
          migration0345.indexOf("-- This is a protocol cutover"),
        );
        await ownerSetup.unsafe(`SET search_path = "${targetA}", opengeni_private, public`);
        await ownerSetup.unsafe(registryPrefix);

        const sharedBeforeRejection = await snapshotSharedFunctions();
        const targetBBeforeRejection = await snapshotTargetObjects(targetB);
        let secondTargetError: unknown;
        try {
          await apply0345Once(targetB);
        } catch (error) {
          secondTargetError = error;
        }
        expect(secondTargetError).toMatchObject({ code: "55000" });
        expect(String(secondTargetError)).toContain(
          "session tenancy target schema is already bound",
        );
        expect(await snapshotSharedFunctions()).toEqual(sharedBeforeRejection);
        expect(await snapshotTargetObjects(targetB)).toEqual(targetBBeforeRejection);
        const [targetBReceipt] = await ownerSetup.unsafe<Array<{ count: number }>>(
          `select count(*)::int as count from "${targetB}".schema_migrations
           where name = '0345_tenant_scoped_session_tenancy_fence.sql'`,
        );
        expect(targetBReceipt?.count).toBe(0);

        await ownerSetup.unsafe(`SET search_path = "${targetA}", opengeni_private, public`);
        expect(
          await ownerSetup`
            select * from opengeni_private.claim_terminal_retained_processes(
              ${crypto.randomUUID()}::uuid, 1, 1000
            )`,
        ).toHaveLength(0);
      } finally {
        await ownerSetup.end({ timeout: 5 });
      }

      const namespaces = await owned.admin<Array<{ name: string; oid: number }>>`
        select nspname as name, oid::int as oid
        from pg_namespace
        where nspname in (${targetA}, ${targetB})
        order by nspname`;
      expect(namespaces.map((namespace) => namespace.name)).toEqual([targetA, targetB]);
      const namespaceOid = new Map(namespaces.map((namespace) => [namespace.name, namespace.oid]));
      const helperNames = [
        "acquire_due_retained_process_session_tenancy_fences",
        "acquire_due_sandbox_rotation_session_tenancy_fences",
        "acquire_organization_session_tenancy_fences",
        "acquire_sandbox_reaper_session_tenancy_fences",
        "acquire_scoped_machine_session_tenancy_fences",
        "acquire_session_tenancy_fence",
        "session_tenancy_fence_owner_policy_active",
        "session_tenancy_fence_target_schema",
      ];
      const helpers = await owned.admin<
        Array<{ schema: string; name: string; source: string; settings: string[] | null }>
      >`
        select namespace.nspname as schema, procedure.proname as name,
          procedure.prosrc as source, procedure.proconfig as settings
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname in (${targetA}, ${targetB})
          and procedure.proname = any(${helperNames})
        order by namespace.nspname, procedure.proname`;
      expect(helpers).toHaveLength(helperNames.length);
      expect(helpers.every((helper) => helper.schema === targetA)).toBe(true);
      expect(helpers.map((helper) => helper.name)).toEqual([...helperNames].sort());
      const identity = helpers.find(
        (helper) => helper.name === "session_tenancy_fence_target_schema",
      );
      expect(identity?.source).toContain(`${namespaceOid.get(targetA)}::oid`);
      for (const helper of helpers.filter(
        (candidate) =>
          candidate.name.startsWith("acquire_") &&
          candidate.name !== "acquire_session_tenancy_fence",
      )) {
        expect(helper.settings, `${targetA}.${helper.name}`).toEqual([
          `search_path=pg_catalog, ${targetA}, pg_temp`,
        ]);
      }
      const globalRoutines = await owned.admin<
        Array<{ signature: string; settings: string[] | null }>
      >`
        select requested.signature, procedure.proconfig as settings
        from unnest(${globalRoutineSignatures}::text[]) requested(signature)
        join pg_proc procedure
          on procedure.oid = to_regprocedure(requested.signature)
        order by requested.signature`;
      expect(globalRoutines).toHaveLength(globalRoutineSignatures.length);
      for (const routine of globalRoutines) {
        expect(routine.settings, routine.signature).toEqual([
          `search_path=pg_catalog, ${targetA}, pg_temp`,
        ]);
      }
      const [registry] = await owned.admin<
        Array<{
          target: string;
          owner: string;
          kind: string;
          columns: string[];
          constraints: string[];
          extraneousAcl: number;
        }>
      >`
        select registry.target_schema::text as target,
          pg_get_userbyid(relation.relowner) as owner,
          relation.relkind::text as kind,
          array(
            select attribute.attname || ':'
              || format_type(attribute.atttypid, attribute.atttypmod) || ':'
              || attribute.attnotnull::text
            from pg_attribute attribute
            where attribute.attrelid = relation.oid and attribute.attnum > 0
              and not attribute.attisdropped order by attribute.attnum
          ) as columns,
          array(
            select constraint_value.conname || ':' || constraint_value.contype::text || ':'
              || pg_get_constraintdef(constraint_value.oid, false)
            from pg_constraint constraint_value
            where constraint_value.conrelid = relation.oid
            order by constraint_value.conname
          ) as constraints,
          (select count(*)::int from aclexplode(coalesce(
            relation.relacl, acldefault('r', relation.relowner)
          )) acl where acl.grantee <> relation.relowner) as "extraneousAcl"
        from opengeni_private.session_tenancy_fence_target_registry registry
        join pg_class relation on relation.oid =
          'opengeni_private.session_tenancy_fence_target_registry'::regclass
        where registry.singleton`;
      expect(registry).toEqual({
        target: targetA,
        owner: owned.ownerRole,
        kind: "r",
        columns: ["singleton:boolean:true", "target_schema:regnamespace:true"],
        constraints: [
          "session_tenancy_fence_target_registry_pk:p:PRIMARY KEY (singleton)",
          "session_tenancy_fence_target_registry_singleton_chk:c:CHECK (singleton)",
        ],
        extraneousAcl: 0,
      });
      const sharedLedgers = await owned.admin<
        Array<{ name: string; owner: string; extraneousAcl: number }>
      >`
        select relation.relname as name,
          pg_get_userbyid(relation.relowner) as owner,
          count(*) filter (
            where exists (
              select 1 from aclexplode(coalesce(
                relation.relacl, acldefault('r', relation.relowner)
              )) acl where acl.grantee <> relation.relowner
            )
          )::int as "extraneousAcl"
        from pg_class relation
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = 'opengeni_private'
          and relation.relname in (
            'session_tenancy_fence_inventory_capabilities',
            'session_tenancy_fenced_access_capabilities'
          )
        group by relation.relname, relation.relowner
        order by relation.relname`;
      expect([...sharedLedgers]).toEqual([
        {
          name: "session_tenancy_fence_inventory_capabilities",
          owner: owned.ownerRole,
          extraneousAcl: 0,
        },
        {
          name: "session_tenancy_fenced_access_capabilities",
          owner: owned.ownerRole,
          extraneousAcl: 0,
        },
      ]);
      const sharedCapabilityFunctions = await owned.admin<
        Array<{
          signature: string;
          owner: string;
          securityDefiner: boolean;
          extraneousAcl: number;
        }>
      >`
        select requested.signature,
          pg_get_userbyid(procedure.proowner) as owner,
          procedure.prosecdef as "securityDefiner",
          (select count(*)::int from aclexplode(coalesce(
            procedure.proacl, acldefault('f', procedure.proowner)
          )) acl where acl.grantee <> procedure.proowner) as "extraneousAcl"
        from unnest(${sharedCapabilitySignatures}::text[]) requested(signature)
        join pg_proc procedure
          on procedure.oid = to_regprocedure(requested.signature)
        order by requested.signature`;
      expect(sharedCapabilityFunctions).toHaveLength(sharedCapabilitySignatures.length);
      expect(
        sharedCapabilityFunctions.every(
          (routine) =>
            routine.owner === owned!.ownerRole &&
            routine.securityDefiner &&
            routine.extraneousAcl === 0,
        ),
      ).toBe(true);
      const [sharedAcquireHelpers] = await owned.admin<Array<{ count: number }>>`
        select count(*)::int as count
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'opengeni_private'
          and procedure.proname like 'acquire%session_tenancy_fence%'`;
      expect(sharedAcquireHelpers?.count).toBe(0);

      const targetANamespaceOid = namespaceOid.get(targetA);
      const targetBNamespaceOid = namespaceOid.get(targetB);
      if (targetANamespaceOid === undefined || targetBNamespaceOid === undefined) {
        throw new Error("target namespace OIDs were not inventoried");
      }

      const ownerRuntime = postgres(owned.ownerUrl, {
        max: 1,
        onnotice: () => undefined,
        connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
      });
      try {
        await ownerRuntime.begin(async (transaction) => {
          const [opened] = await transaction<Array<{ capabilityA: string }>>`
            select opengeni_private.open_session_tenancy_fence_inventory(
              ${targetANamespaceOid}::oid
            ) as "capabilityA"`;
          if (!opened) throw new Error("target capability tokens were not opened");
          const [active] = await transaction<Array<{ active: boolean }>>`
            select opengeni_private.session_tenancy_fence_inventory_capability_active(
              ${targetANamespaceOid}::oid
            ) as active`;
          expect(active?.active).toBe(true);
          await transaction`
            select opengeni_private.close_session_tenancy_fence_inventory(
              ${opened.capabilityA}::uuid
            )`;
        });
        await expect(
          ownerRuntime.begin(
            async (transaction) =>
              await transaction`
              select opengeni_private.open_session_tenancy_fence_inventory(
                ${targetBNamespaceOid}::oid
              )`,
          ),
        ).rejects.toMatchObject({ code: "22023" });
      } finally {
        await ownerRuntime.end({ timeout: 5 });
      }

      // A host-supplied runtime role that was unknown when the SQL was written
      // can plan the PUBLIC value-free predicate inside the RLS policies. It
      // still cannot call any target acquire helper or private ledger function.
      await owned.admin.unsafe(
        `GRANT USAGE ON SCHEMA "${targetA}", opengeni_private TO "${runtimeRole}";
         GRANT SELECT ON TABLE "${targetA}".sessions TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION "${targetA}".session_private_actor_visible(
           uuid, uuid, uuid, text
         ) TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.workspace_rls_visible(
           uuid, uuid
         ) TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.current_account_id()
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.current_workspace_id()
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.variable_set_authority_capability_active(text)
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.session_ownership_capability_active()
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.personal_document_authority_capability_active(text)
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.organization_tenancy_inventory_capability_active()
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.organization_tenancy_parity_capability_active()
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.personal_resource_delegation_capability_active(text)
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.resource_classification_capability_active()
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.scheduled_personal_resource_capability_active(text)
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.connection_tenancy_backfill_capability_active(uuid)
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.document_migration_capability_active(text)
           TO "${runtimeRole}";
         GRANT EXECUTE ON FUNCTION opengeni_private.scoped_compute_capability_active(text)
           TO "${runtimeRole}"`,
      );
      await owned.admin.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE "${runtimeRole}"`);
        await transaction.unsafe(`SET LOCAL search_path = "${targetA}", opengeni_private, public`);
        const [planned] = await transaction<Array<{ count: number }>>`
          select count(*)::int as count from sessions`;
        expect(planned?.count).toBe(0);
        const [privileges] = await transaction<
          Array<{
            predicate: boolean;
            acquire: boolean;
            openInventory: boolean;
            openFencedAccess: boolean;
          }>
        >`
          select
            has_function_privilege(
              current_user,
              'session_tenancy_fence_owner_policy_active(text,text,oid,uuid,boolean)',
              'EXECUTE'
            ) as predicate,
            has_function_privilege(
              current_user,
              'acquire_session_tenancy_fence(uuid)',
              'EXECUTE'
            ) as acquire,
            has_function_privilege(
              current_user,
              'opengeni_private.open_session_tenancy_fence_inventory(oid)',
              'EXECUTE'
            ) as "openInventory",
            has_function_privilege(
              current_user,
              'opengeni_private.open_session_tenancy_fenced_access(oid)',
              'EXECUTE'
            ) as "openFencedAccess"`;
        expect(privileges).toEqual({
          predicate: true,
          acquire: false,
          openInventory: false,
          openFencedAccess: false,
        });
      });

      // CREATE OR REPLACE preserves direct grants. A poisoned same-signature
      // capability function must make a manual same-target SQL replay fail
      // closed at the shared function contract.
      await owned.admin.unsafe(
        `GRANT EXECUTE ON FUNCTION
           opengeni_private.open_session_tenancy_fence_inventory(oid)
         TO "${runtimeRole}"`,
      );
      const ownerAclReplay = postgres(owned.ownerUrl, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        await ownerAclReplay.unsafe(`SET search_path = "${targetA}", opengeni_private, public`);
        let aclDriftError: unknown;
        try {
          await ownerAclReplay.unsafe(await readFile(migrationUrl, "utf8"));
        } catch (error) {
          aclDriftError = error;
        }
        expect(aclDriftError).toMatchObject({ code: "55000" });
        expect(String(aclDriftError)).toContain(
          "shared session tenancy capability function ACL drift",
        );
      } finally {
        await ownerAclReplay.end({ timeout: 5 });
        await owned.admin.unsafe(
          `REVOKE ALL ON FUNCTION
             opengeni_private.open_session_tenancy_fence_inventory(oid)
           FROM "${runtimeRole}"`,
        );
      }
    } finally {
      await owned.admin.unsafe(`DROP OWNED BY "${runtimeRole}"`).catch(() => undefined);
      await owned.admin.unsafe(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(() => undefined);
      owned = primaryOwned;
      await isolated.release();
    }
  }, 900_000);
});
