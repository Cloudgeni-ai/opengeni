import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { provisionRoles } from "../src/provision-roles";

test("0933 fences live runtimes and prevents event capability temp-table shadowing", async () => {
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
      new URL("../drizzle/0933_background_capability_posture.sql", import.meta.url),
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

import { migrate } from "../src/migrate";
import { createDb, bootstrapWorkspace } from "../src";

// Restricted migration owners must still discover private work without giving
// the application direct, unscoped access to recording content.
test("recording recovery inventory is owner-only and returns private due-work identifiers", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("recording-inventory-repair");
  if (!owned) throw new Error("Real PostgreSQL required");
  let client: ReturnType<typeof createDb> | undefined;
  let runtime: postgres.Sql | undefined;
  try {
    await migrate(owned.ownerUrl);
    await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
    const url = new URL(owned.ownerUrl);
    url.username = "opengeni_app";
    url.password = owned.appPassword;
    client = createDb(url.toString());
    const grants = [];
    for (let index = 0; index < 2; index++) {
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "recording-repair",
        accountExternalId: crypto.randomUUID(),
        accountName: "Repair",
        workspaceExternalSource: "recording-repair",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Repair",
        subjectId: `private-owner:${crypto.randomUUID()}`,
      });
      grants.push(access.workspaceGrants[0]!);
    }
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (let index = 0; index < 2; index++) {
      const grant = grants[index]!;
      await owned.admin`insert into recordings(id,account_id,workspace_id,owner_subject_id,title,state,capture_ended_at,updated_at)
        values(${ids[index]},${grant.accountId},${grant.workspaceId},${grant.subjectId},'Private content',${index === 0 ? "processing" : "deleting"},now(),now()-interval '5 minutes')`;
    }
    const versionId = crypto.randomUUID();
    await owned.admin`insert into recording_transcript_versions(id,account_id,workspace_id,recording_id,version_number,provider_id,model,requested_by_subject_id,created_at)
      values(${versionId},${grants[0]!.accountId},${grants[0]!.workspaceId},${ids[0]},1,'test','test',${grants[0]!.subjectId},now()-interval '5 minutes')`;
    const [owner] =
      await owned.admin`select rolsuper,rolbypassrls from pg_roles where rolname=${owned.ownerRole}`;
    expect(owner).toEqual({ rolsuper: false, rolbypassrls: false });
    runtime = postgres(url.toString(), { max: 1 });
    expect(await runtime`select id from recordings`).toHaveLength(0);
    expect(await runtime`select id from recording_transcript_versions`).toHaveLength(0);
    const rows = await runtime`select * from opengeni_private.list_stalled_recording_work_v1(50)`;
    expect(rows.map((row) => row.recording_id).sort()).toEqual(ids.sort());
    expect(rows.map((row) => row.kind).sort()).toEqual(["deletion", "transcript"]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "account_id",
      "kind",
      "owner_subject_id",
      "recording_id",
      "version_id",
      "workspace_id",
    ]);
    await owned.admin.begin(async (tx) => {
      await tx`create temp table recordings(trap text)`;
      await tx`create temp table recording_transcript_versions(trap text)`;
      await tx`grant all on pg_temp.recordings,pg_temp.recording_transcript_versions to opengeni_app`;
      await tx`set local role opengeni_app`;
      expect(
        await tx`select * from opengeni_private.list_stalled_recording_work_v1(50)`,
      ).toHaveLength(2);
    });
  } finally {
    await runtime?.end();
    await client?.close();
    await owned.release();
  }
}, 180_000);
