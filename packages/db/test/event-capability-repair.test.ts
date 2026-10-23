import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { provisionRoles } from "../src/provision-roles";

test("0931 fences live runtimes and prevents event capability temp-table shadowing", async () => {
  const shared = await acquireSharedTestDatabase("event-capability-repair");
  if (!shared) throw new Error("Real PostgreSQL required");
  const role = `event_reader_${crypto.randomUUID().replaceAll("-", "")}`;
  const password = crypto.randomUUID();
  let runtime: postgres.Sql | undefined;
  try {
    await provisionRoles(shared.adminUrl, { appRole: role, appPassword: password });
    const url = new URL(shared.appUrl);
    url.username = role;
    url.password = password;
    runtime = postgres(url.toString(), { max: 1 });
    await runtime`select 1`;
    const migration = await readFile(
      new URL("../drizzle/0931_event_capability_posture.sql", import.meta.url),
      "utf8",
    );
    const refused = await shared.admin
      .begin(async (tx) => {
        await tx`select set_config('opengeni.migration_application_roles', ${JSON.stringify([role])}, true)`;
        await tx.unsafe(migration);
      })
      .then(
        () => null,
        (error) => error.code,
      );
    expect(refused).toBe("55000");
    await runtime.end();
    runtime = undefined;
    await shared.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.migration_application_roles', ${JSON.stringify([role])}, true)`;
      await tx.unsafe(migration);
    });
    for (const signature of [
      "list_due_event_trigger_tasks_v1(integer)",
      "prune_event_intake_v1(integer, integer, integer)",
    ]) {
      const [before] = await shared.admin`
        select has_function_privilege(${role}, ${"opengeni_private." + signature}, 'execute') as allowed`;
      expect(before!.allowed).toBe(false);
    }
    await provisionRoles(shared.adminUrl, { appRole: role, appPassword: password });
    await shared.admin.begin(async (tx) => {
      for (const table of ["scheduled_task_event_settings", "event_deliveries", "inbound_events"]) {
        await tx.unsafe(`create temp table ${table}(trap text)`);
        await tx.unsafe(`grant all on table pg_temp.${table} to "${role}"`);
      }
      await tx.unsafe(`set local role "${role}"`);
      const due = await tx`select * from opengeni_private.list_due_event_trigger_tasks_v1(1)`;
      expect(due).toHaveLength(0);
      const [pruned] =
        await tx`select opengeni_private.prune_event_intake_v1(3600,86400,1) as count`;
      expect(pruned!.count).toBe(0);
    });
  } finally {
    await runtime?.end();
    await shared.admin.unsafe(`DROP OWNED BY "${role}"`);
    await shared.admin.unsafe(`DROP ROLE "${role}"`);
    await shared.release();
  }
}, 180_000);
