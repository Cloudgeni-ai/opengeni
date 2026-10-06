import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initialSandboxMachine, type SandboxMachineRecord } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { createDb, withRlsContext, type DbClient } from "../src/database";
import { nestedPostgresSqlState } from "../src";
import {
  findSandboxMachine,
  compareAndSetSandboxMachine,
  insertSandboxMachineInTransaction,
  listSandboxMachineInventory,
} from "../src/sandbox-v2-machines";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

let owned: OwnerMigratedTestDatabase;
let app: DbClient;
let first: { accountId: string; workspaceId: string; sandboxGroupId: string };
let second: typeof first;

beforeAll(async () => {
  const fixture = await acquireOwnerMigratedTestDatabase("sandbox-v2-machines");
  if (!fixture) throw new Error("Sandbox machine migration requires disposable PostgreSQL");
  owned = fixture;
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  app = createDb(url.toString(), { rlsStrategy: "force" });
  async function tenant() {
    const [account] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts(name) values ('machine-fixture') returning id`;
    const [workspace] = await owned.admin<{ id: string }[]>`
      insert into workspaces(account_id,name) values (${account!.id},'machine-fixture') returning id`;
    return {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sandboxGroupId: crypto.randomUUID(),
    };
  }
  first = await tenant();
  second = await tenant();
}, 180_000);
afterAll(async () => {
  await app?.close();
  await owned?.release();
}, 180_000);

async function state(action: () => Promise<unknown>, expected: string) {
  let error: unknown;
  try {
    await action();
  } catch (failure) {
    error = failure;
  }
  expect(nestedPostgresSqlState(error)).toBe(expected);
}
async function insert(tenant: typeof first, projection: SandboxMachineRecord) {
  await withRlsContext(app.db, tenant, (tx) =>
    insertSandboxMachineInTransaction(tx, tenant.accountId, projection),
  );
}
async function legacy(tenant: typeof first) {
  await withRlsContext(app.db, tenant, (tx) =>
    tx.execute(sql`
    insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,liveness,backend,os,expires_at)
    values (${tenant.accountId}::uuid,${tenant.workspaceId}::uuid,${tenant.sandboxGroupId}::uuid,
      'cold','docker','linux',now()+interval '1 minute')`),
  );
}

describe("sandbox v2 durable store", () => {
  test("engine and preparation guards bind the installation schema independently of caller search_path", async () => {
    const fixture = await acquireOwnerMigratedTestDatabase("sandbox-v2-schema");
    if (!fixture) throw new Error("Dedicated schema requires disposable PostgreSQL");
    const schema = "sandbox_engine_fixture";
    let embedded: DbClient | undefined;
    try {
      await fixture.admin.unsafe(
        `create schema ${schema} authorization "${fixture.ownerRole.replaceAll('"', '""')}"`,
      );
      // Established embedded fixture posture: schema-pinned vector signatures
      // resolve the extension in that same installation's namespace.
      await fixture.admin.unsafe(`alter extension vector set schema ${schema}`);
      await migrate(fixture.ownerUrl, schema, { applicationDatabaseRoles: ["opengeni_app"] });
      await provisionRoles(fixture.adminUrl, {
        targetSchema: schema,
        appPassword: fixture.appPassword,
        rlsStrategy: "force",
      });
      const appUrl = new URL(fixture.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = fixture.appPassword;
      embedded = createDb(appUrl.toString(), {
        searchPath: `${schema}, public`,
        rlsStrategy: "force",
      });
      const [account] = await fixture.admin.unsafe<{ id: string }[]>(
        `insert into ${schema}.managed_accounts(name) values ('engine-schema-fixture') returning id`,
      );
      const [workspace] = await fixture.admin.unsafe<{ id: string }[]>(
        `insert into ${schema}.workspaces(account_id,name) values ($1,'engine-schema-fixture') returning id`,
        [account!.id],
      );
      const scope = {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sandboxGroupId: crypto.randomUUID(),
      };
      await withRlsContext(embedded.db, scope, (tx) =>
        insertSandboxMachineInTransaction(
          tx,
          scope.accountId,
          initialSandboxMachine(scope, "docker", crypto.randomUUID()),
        ),
      );
      await state(
        () =>
          withRlsContext(embedded!.db, scope, (tx) =>
            tx.execute(sql`
        insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,liveness,backend,os,expires_at)
        values (${scope.accountId}::uuid,${scope.workspaceId}::uuid,${scope.sandboxGroupId}::uuid,
          'cold','docker','linux',now()+interval '1 minute')`),
          ),
        "23514",
      );
      const old = { ...scope, sandboxGroupId: crypto.randomUUID() };
      await withRlsContext(embedded.db, old, (tx) =>
        tx.execute(sql`
        insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,liveness,backend,os,expires_at)
        values (${old.accountId}::uuid,${old.workspaceId}::uuid,${old.sandboxGroupId}::uuid,
          'cold','docker','linux',now()+interval '1 minute')`),
      );
      await state(
        () =>
          withRlsContext(embedded!.db, old, (tx) =>
            insertSandboxMachineInTransaction(
              tx,
              old.accountId,
              initialSandboxMachine(old, "docker", crypto.randomUUID()),
            ),
          ),
        "23514",
      );
      const [counts] = await fixture.admin.unsafe<{ modern: number; legacy: number }[]>(`select
        (select count(*)::int from ${schema}.sandbox_v2_machines) as modern,
        (select count(*)::int from ${schema}.sandbox_leases) as legacy`);
      expect(counts).toEqual({ modern: 1, legacy: 1 });
      const inventory = await listSandboxMachineInventory(embedded.db);
      expect(inventory.items).toHaveLength(1);
      expect(inventory.items[0]).toMatchObject({ ...scope, provider: "docker" });
      const routines = await fixture.admin.unsafe<{ config: string[] }[]>(
        `select proconfig as config
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=$1 and p.proname in ('guard_sandbox_group_engine',
          'guard_sandbox_v2_machine','guard_legacy_sandbox_engine',
          'guard_sandbox_v2_preparation_plan','guard_sandbox_v2_credential_generation',
          'guard_sandbox_v2_credential_owner','guard_sandbox_v2_background_owner',
          'sandbox_v2_command_has_background_owner','sandbox_v2_attempt_writers_pending')`,
        [schema],
      );
      expect(routines).toHaveLength(9);
      for (const routine of routines)
        expect(routine.config).toContain(`search_path=pg_catalog, ${schema}, pg_temp`);
    } finally {
      await embedded?.close();
      await fixture.release();
    }
  }, 180_000);
  test("bounded global inventory exposes identities without leaking tenant scope or table access", async () => {
    const scopes = [first, second].map((tenant) => ({
      ...tenant,
      sandboxGroupId: crypto.randomUUID(),
    }));
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, scope] of scopes.entries())
      await insert(scope, initialSandboxMachine(scope, "docker", ids[index]!));
    await withRlsContext(app.db, first, async (tx) => {
      const seen = new Set<string>();
      let afterMachineId: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await listSandboxMachineInventory(tx, {
          limit: 1,
          ...(afterMachineId ? { afterMachineId } : {}),
        });
        expect(result.items.length).toBeLessThanOrEqual(1);
        for (const item of result.items) {
          expect(Object.keys(item).sort()).toEqual([
            "accountId",
            "machineId",
            "provider",
            "sandboxGroupId",
            "workspaceId",
          ]);
          expect(seen.has(item.machineId)).toBe(false);
          seen.add(item.machineId);
        }
        if (!result.nextMachineId) break;
        afterMachineId = result.nextMachineId;
      }
      for (const id of ids) expect(seen.has(id)).toBe(true);
      const hidden = await tx.execute(sql`select id from sandbox_v2_machines
        where account_id=${second.accountId}::uuid`);
      expect(hidden).toHaveLength(0);
      const gucs = await tx.execute(sql`select current_setting('opengeni.account_id') as account,
        current_setting('opengeni.workspace_id') as workspace`);
      expect(gucs).toMatchObject([{ account: first.accountId, workspace: first.workspaceId }]);
    });
    await state(
      () => app.db.execute(sql`select * from list_sandbox_v2_machine_inventory(0,null)`),
      "22023",
    );
    await state(
      () => app.db.execute(sql`select * from list_sandbox_v2_machine_inventory(null,null)`),
      "22023",
    );
    await withRlsContext(app.db, first, async (tx) => {
      const [opened] = await tx.execute(sql`select
        opengeni_private.open_session_tenancy_fence_inventory('public'::regnamespace::oid) as id`);
      try {
        // The helper is callable by the runtime role. Its transaction capability
        // grants inventory visibility only to the actual definer owner.
        const hidden = await tx.execute(sql`select id from sandbox_v2_machines
          where account_id=${second.accountId}::uuid`);
        expect(hidden).toHaveLength(0);
      } finally {
        await tx.execute(sql`select opengeni_private.close_session_tenancy_fence_inventory(
          ${opened!.id}::uuid)`);
      }
    });
    const [capabilities] = await owned.admin<{ count: number }[]>`select count(*)::int as count
      from opengeni_private.session_tenancy_fence_inventory_capabilities`;
    expect(capabilities?.count).toBe(0);
    const [privileges] = await owned.admin<{ public_execute: boolean }[]>`select exists (
      select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid='list_sandbox_v2_machine_inventory(integer,uuid)'::regprocedure
      and a.grantee=0 and a.privilege_type='EXECUTE') as public_execute`;
    expect(privileges?.public_execute).toBe(false);
  });
  test("stale repeatable-read and serializable snapshots cannot admit a second engine", async () => {
    for (const isolationLevel of ["repeatable read", "serializable"] as const) {
      for (const modernFirst of [true, false]) {
        const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
        let started!: () => void;
        let resume!: () => void;
        const snapshotTaken = new Promise<void>((resolve) => {
          started = resolve;
        });
        const continueInsert = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const contender = withRlsContext(
          app.db,
          tenant,
          async (tx) => {
            await tx.execute(sql`select count(*) from sandbox_group_engines
            where workspace_id=${tenant.workspaceId}::uuid and sandbox_group_id=${tenant.sandboxGroupId}::uuid`);
            started();
            await continueInsert;
            if (modernFirst)
              await tx.execute(sql`
            insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,liveness,backend,os,expires_at)
            values (${tenant.accountId}::uuid,${tenant.workspaceId}::uuid,${tenant.sandboxGroupId}::uuid,
              'cold','docker','linux',now()+interval '1 minute')`);
            else
              await insertSandboxMachineInTransaction(
                tx,
                tenant.accountId,
                initialSandboxMachine(tenant, "docker", crypto.randomUUID()),
              );
          },
          { isolationLevel },
        );
        // Attach rejection handling before the independent winner commits.
        const result = contender.then(
          () => null,
          (error) => error,
        );
        await snapshotTaken;
        try {
          if (modernFirst)
            await insert(tenant, initialSandboxMachine(tenant, "docker", crypto.randomUUID()));
          else await legacy(tenant);
        } finally {
          resume();
        }
        expect(["23514", "40001"].includes(nestedPostgresSqlState(await result) ?? "")).toBe(true);
        const [counts] = await owned.admin<{ count: number }[]>`select
          (select count(*)::int from sandbox_v2_machines where workspace_id=${tenant.workspaceId}::uuid
            and sandbox_group_id=${tenant.sandboxGroupId}::uuid) +
          (select count(*)::int from sandbox_leases where workspace_id=${tenant.workspaceId}::uuid
            and sandbox_group_id=${tenant.sandboxGroupId}::uuid) as count`;
        expect(counts?.count).toBe(1);
      }
    }
  });
  test("legacy identity is immutable and its engine survives lease deletion", async () => {
    const old = { ...first, sandboxGroupId: crypto.randomUUID() };
    const modern = { ...first, sandboxGroupId: crypto.randomUUID() };
    await legacy(old);
    await insert(modern, initialSandboxMachine(modern, "docker", crypto.randomUUID()));
    await state(
      () =>
        withRlsContext(app.db, old, (tx) =>
          tx.execute(sql`
      update sandbox_leases set sandbox_group_id=${modern.sandboxGroupId}::uuid
      where workspace_id=${old.workspaceId}::uuid and sandbox_group_id=${old.sandboxGroupId}::uuid`),
        ),
      "23514",
    );
    await withRlsContext(app.db, old, (tx) =>
      tx.execute(sql`delete from sandbox_leases
      where workspace_id=${old.workspaceId}::uuid and sandbox_group_id=${old.sandboxGroupId}::uuid`),
    );
    await state(
      () => insert(old, initialSandboxMachine(old, "docker", crypto.randomUUID())),
      "23514",
    );
    await legacy(old); // Recreating the legacy lease retains its engine.
    await state(
      () =>
        withRlsContext(app.db, old, (tx) =>
          tx.execute(sql`
      update sandbox_group_engines set engine='machine-v2' where workspace_id=${old.workspaceId}::uuid`),
        ),
      "42501",
    );
  });
  test("legacy and v2 admissions exclude each other, including concurrent inserts", async () => {
    const old = { ...first, sandboxGroupId: crypto.randomUUID() };
    await legacy(old);
    await state(
      () => insert(old, initialSandboxMachine(old, "docker", crypto.randomUUID())),
      "23514",
    );
    const modern = { ...first, sandboxGroupId: crypto.randomUUID() };
    await insert(modern, initialSandboxMachine(modern, "docker", crypto.randomUUID()));
    await state(() => legacy(modern), "23514");
    for (let race = 0; race < 8; race++) {
      const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
      const result = await Promise.allSettled([
        insert(tenant, initialSandboxMachine(tenant, "docker", crypto.randomUUID())),
        legacy(tenant),
      ]);
      expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = result.find((item) => item.status === "rejected");
      expect(nestedPostgresSqlState(rejected?.reason)).toBe("23514");
      const [counts] = await owned.admin<{ count: number }[]>`select
        (select count(*)::int from sandbox_v2_machines where workspace_id=${tenant.workspaceId}::uuid
          and sandbox_group_id=${tenant.sandboxGroupId}::uuid) +
        (select count(*)::int from sandbox_leases where workspace_id=${tenant.workspaceId}::uuid
          and sandbox_group_id=${tenant.sandboxGroupId}::uuid) as count`;
      expect(counts?.count).toBe(1);
    }
  });
  test("scope and FORCE RLS contain the projection, including non-bypass owner reads", async () => {
    const machine = initialSandboxMachine(first, "synthetic", crypto.randomUUID());
    await insert(first, machine);
    expect(await findSandboxMachine(app.db, first)).toEqual(machine);
    expect(await findSandboxMachine(app.db, { ...first, accountId: second.accountId })).toBeNull();
    expect(
      await findSandboxMachine(app.db, { ...first, workspaceId: second.workspaceId }),
    ).toBeNull();
    const unscoped = await app.db.execute(
      sql`select count(*)::int as count from sandbox_v2_machines`,
    );
    expect(unscoped[0]?.count).toBe(0);
    const [metadata] = await owned.admin<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where oid='sandbox_v2_machines'::regclass`;
    expect(metadata).toEqual({ rls: true, forced: true });
    const owner = createDb(owned.ownerUrl);
    try {
      const hidden = await owner.db.execute(
        sql`select count(*)::int as count from sandbox_v2_machines`,
      );
      expect(hidden[0]?.count).toBe(0);
    } finally {
      await owner.close();
    }
  });
  test("one concurrent CAS wins; stale coordinators cannot overwrite ownership", async () => {
    const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
    const previous = initialSandboxMachine(tenant, "synthetic", crypto.randomUUID());
    await insert(tenant, previous);
    const next: SandboxMachineRecord = {
      ...previous,
      version: 1,
      target: "running",
      demands: [
        {
          id: crypto.randomUUID(),
          owner: crypto.randomUUID(),
          kind: "attempt",
          authority: crypto.randomUUID(),
        },
      ],
    };
    const writes = await Promise.all(
      Array.from({ length: 16 }, () =>
        compareAndSetSandboxMachine(app.db, tenant.accountId, previous, next),
      ),
    );
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect(await findSandboxMachine(app.db, tenant)).toEqual(next);
    expect(
      await compareAndSetSandboxMachine(app.db, tenant.accountId, previous, {
        ...next,
        demands: [],
      }),
    ).toBe(false);
  });
  test("identity/version guards and monotonic destruction apply to direct SQL too", async () => {
    const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
    const machine = initialSandboxMachine(tenant, "synthetic", crypto.randomUUID());
    await insert(tenant, machine);
    await expect(
      compareAndSetSandboxMachine(app.db, tenant.accountId, machine, {
        ...machine,
        version: 1,
        provider: "other",
      }),
    ).rejects.toThrow("immutable");
    await state(
      () =>
        withRlsContext(app.db, tenant, (tx) =>
          tx.execute(sql`
      update sandbox_v2_machines set version=2, projection=jsonb_set(projection,'{version}','2'::jsonb)
      where id=${machine.id}::uuid`),
        ),
      "23514",
    );
    const destroyed: SandboxMachineRecord = { ...machine, version: 1, target: "destroyed" };
    expect(await compareAndSetSandboxMachine(app.db, tenant.accountId, machine, destroyed)).toBe(
      true,
    );
    await state(
      () =>
        compareAndSetSandboxMachine(app.db, tenant.accountId, destroyed, {
          ...destroyed,
          version: 2,
          target: "running",
        }),
      "23514",
    );
  });
  test("retained transition configuration cannot change or redispatch after an unknown outcome", async () => {
    const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
    const machine = initialSandboxMachine(tenant, "synthetic", crypto.randomUUID());
    await insert(tenant, machine);
    const reserved: SandboxMachineRecord = {
      ...machine,
      version: 1,
      target: "running",
      transition: {
        id: crypto.randomUUID(),
        kind: "create",
        phase: "reserved",
        definition: { image: "synthetic-image-a", memory: 256 },
        before: { state: "absent", instance: null, disk: null },
      },
    };
    expect(await compareAndSetSandboxMachine(app.db, tenant.accountId, machine, reserved)).toBe(
      true,
    );
    for (const transition of [
      { ...reserved.transition!, definition: { image: "synthetic-image-b", memory: 512 } },
      { ...reserved.transition!, id: crypto.randomUUID() },
      {
        ...reserved.transition!,
        before: { state: "suspended" as const, instance: null, disk: null },
      },
    ])
      await state(
        () =>
          compareAndSetSandboxMachine(app.db, tenant.accountId, reserved, {
            ...reserved,
            version: 2,
            transition,
          }),
        "23514",
      );
    const dispatched: SandboxMachineRecord = {
      ...reserved,
      version: 2,
      transition: { ...reserved.transition!, phase: "dispatched" },
    };
    expect(await compareAndSetSandboxMachine(app.db, tenant.accountId, reserved, dispatched)).toBe(
      true,
    );
    await state(
      () =>
        compareAndSetSandboxMachine(app.db, tenant.accountId, dispatched, {
          ...dispatched,
          version: 3,
          transition: reserved.transition,
        }),
      "23514",
    );
    const unknown: SandboxMachineRecord = {
      ...dispatched,
      version: 3,
      transition: { ...dispatched.transition!, phase: "unknown" },
    };
    expect(await compareAndSetSandboxMachine(app.db, tenant.accountId, dispatched, unknown)).toBe(
      true,
    );
    await state(
      () =>
        compareAndSetSandboxMachine(app.db, tenant.accountId, unknown, {
          ...unknown,
          version: 4,
          transition: dispatched.transition,
        }),
      "23514",
    );
    expect(await findSandboxMachine(app.db, tenant)).toEqual(unknown);
    expect(
      await compareAndSetSandboxMachine(app.db, tenant.accountId, unknown, {
        ...unknown,
        version: 4,
        state: "suspended",
        disk: { synthetic: "disk" },
        transition: null,
      }),
    ).toBe(true);
  });
  test("null projection identity cannot evade SQL CHECK through three-valued logic", async () => {
    const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
    const machine = initialSandboxMachine(tenant, "synthetic", crypto.randomUUID());
    const invalid = JSON.stringify({ ...machine, id: null });
    await state(
      () =>
        withRlsContext(app.db, tenant, (tx) =>
          tx.execute(sql`
      insert into sandbox_v2_machines(id,account_id,workspace_id,sandbox_group_id,provider,projection)
      values (${machine.id}::uuid,${tenant.accountId}::uuid,${tenant.workspaceId}::uuid,
        ${tenant.sandboxGroupId}::uuid,'synthetic',${invalid}::jsonb)`),
        ),
      "23514",
    );
    expect(await findSandboxMachine(app.db, tenant)).toBeNull();
  });
  test("SQL refuses coercible version strings and non-fresh admission", async () => {
    const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
    const machine = initialSandboxMachine(tenant, "synthetic", crypto.randomUUID());
    for (const projection of [
      { ...machine, version: "0" },
      { ...machine, idleSince: 1 },
    ]) {
      await state(
        () =>
          withRlsContext(app.db, tenant, (tx) =>
            tx.execute(sql`
        insert into sandbox_v2_machines(id,account_id,workspace_id,sandbox_group_id,provider,projection)
        values (${machine.id}::uuid,${tenant.accountId}::uuid,${tenant.workspaceId}::uuid,
          ${tenant.sandboxGroupId}::uuid,'synthetic',${JSON.stringify(projection)}::jsonb)`),
          ),
        "23514",
      );
    }
    expect(await findSandboxMachine(app.db, tenant)).toBeNull();
  });
  test("direct deletion cannot erase recorded engine; tenant deletion can cascade", async () => {
    const tenant = { ...first, sandboxGroupId: crypto.randomUUID() };
    const machine = initialSandboxMachine(tenant, "synthetic", crypto.randomUUID());
    await insert(tenant, machine);
    await state(
      () =>
        withRlsContext(app.db, tenant, (tx) =>
          tx.execute(sql`
      delete from sandbox_v2_machines where id=${machine.id}::uuid`),
        ),
      "42501",
    );
    // Even a maintenance role with DELETE cannot erase retained identity directly.
    await state(
      () => owned.admin`delete from sandbox_v2_machines where id=${machine.id}::uuid`,
      "23514",
    );
    expect(await findSandboxMachine(app.db, tenant)).toEqual(machine);
    const [workspace] = await owned.admin<{ id: string }[]>`
      insert into workspaces(account_id,name) values (${second.accountId},'cascade-fixture') returning id`;
    const deletedTenant = {
      ...second,
      workspaceId: workspace!.id,
      sandboxGroupId: crypto.randomUUID(),
    };
    await insert(
      deletedTenant,
      initialSandboxMachine(deletedTenant, "synthetic", crypto.randomUUID()),
    );
    await owned.admin`delete from workspaces where id=${deletedTenant.workspaceId}::uuid`;
    const [retained] = await owned.admin<{ count: number }[]>`
      select count(*)::int as count from sandbox_v2_machines where workspace_id=${deletedTenant.workspaceId}::uuid`;
    expect(retained?.count).toBe(0);
  });
});
