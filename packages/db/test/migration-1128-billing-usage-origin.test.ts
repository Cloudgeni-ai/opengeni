import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createScheduledTask, type DbClient } from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// Contract: the billing-origin migration runs after main's 1115 creator lock
// on every database that already applied it (the migrator applies pending
// files in name order), so it must keep 1115's exclusion of creator_locked
// from the scheduled-task execution digest, and every other part of the
// routines it patches, while adding billing_origin.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const ROUTINES = [
  "scheduled_task_execution_digest",
  "set_scheduled_task_execution_digest",
  "scheduled_task_execution_state",
  "fence_scheduled_task_personal_resource_execution_update",
] as const;

setDefaultTimeout(120_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let directory: string | null = null;
let ours = "";
let beforeOurs = new Map<string, string>();

async function definitions(): Promise<Map<string, string>> {
  const rows = await owned!.admin<{ name: string; definition: string }[]>`
    select p.proname as name, pg_catalog.pg_get_functiondef(p.oid) as definition
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${[...ROUTINES]}::text[])`;
  return new Map(rows.map((row) => [row.name, row.definition]));
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-1128-billing-origin");
  if (!owned) {
    if (requireRealDatabase) throw new Error("PostgreSQL fixture is unavailable");
    return;
  }
  // A database that already ran every shipped migration before ours, main's
  // 1115 included, then upgrades to the release that adds ours (and any later
  // migration that builds on it).
  directory = await mkdtemp(join(tmpdir(), "og-migration-1128-"));
  const files = (await readdir(SHIPPED)).filter((file) => file.endsWith(".sql")).sort();
  ours = files.find((file) => file.endsWith("_billing_usage_origin.sql")) ?? "";
  if (!ours) throw new Error("the billing-origin migration is missing");
  for (const file of files) {
    if (file < ours) await symlink(join(SHIPPED, file), join(directory, file));
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory });
  beforeOurs = await definitions();
  for (const file of files) {
    if (file >= ours) await symlink(join(SHIPPED, file), join(directory, file));
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 60_000);

test("upgrading after 1115 adds billing_origin to each exclusion list and keeps the rest", async () => {
  if (!owned) return;
  const after = await definitions();
  expect([...after.keys()].sort()).toEqual([...ROUTINES].sort());
  for (const routine of ROUTINES) {
    const previous = beforeOurs.get(routine)!;
    const current = after.get(routine)!;
    expect(previous).not.toContain("'billing_origin'");
    expect(current).toContain("'billing_origin'");
    // Only the inserted name differs: 1115's creator_locked and the rest of
    // main's current body survive.
    expect(current.replaceAll(", 'billing_origin'", "")).toBe(previous);
  }
  for (const digest of ["scheduled_task_execution_digest", "set_scheduled_task_execution_digest"]) {
    expect(after.get(digest)).toContain("'creator_locked'");
  }

  // Rerunning the patch changes nothing.
  const source = await readFile(join(SHIPPED, ours), "utf8");
  const start = source.indexOf("DO $migration$");
  const end = source.indexOf("$migration$;", start + 1);
  expect(start).toBeGreaterThan(0);
  await owned.admin.unsafe(source.slice(start, end + "$migration$;".length));
  expect(await definitions()).toEqual(after);
});

test("neither the creator lock nor the funding origin changes a task's execution", async () => {
  if (!owned || !client) return;
  const suffix = crypto.randomUUID();
  const subjectId = `subject-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "migration-1128",
    accountExternalId: suffix,
    accountName: "Migration 1128",
    workspaceExternalSource: "migration-1128",
    workspaceExternalId: suffix,
    workspaceName: "Migration 1128",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    name: "Schedule",
    status: "paused",
    visibility: "workspace_shared",
    schedule: { type: "manual" },
    temporalScheduleId: crypto.randomUUID(),
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    createdBy: { kind: "subject", subjectId },
    agentConfig: { prompt: "Check", resources: [], tools: [], metadata: {} },
    metadata: {},
  });
  const execution = async () => {
    const [row] = await owned!.admin<
      { stored: string; computed: string; state: unknown; revision: number }[]
    >`
      select execution_digest as stored, scheduled_task_execution_digest(t) as computed,
        scheduled_task_execution_state(t) as state, authority_revision as revision
      from scheduled_tasks t where t.id = ${task.id}::uuid`;
    return { ...row!, revision: Number(row!.revision) };
  };
  const initial = await execution();
  expect(initial.computed).toBe(initial.stored);

  // The creator lock is mutation authority, not execution (1115).
  await owned.admin`update scheduled_tasks set creator_locked = true where id = ${task.id}::uuid`;
  const locked = await execution();
  expect(locked.stored).toBe(initial.stored);
  expect(locked.computed).toBe(initial.stored);

  // A personal-resource task: the fence would advance its authority revision
  // on an execution change and leave it without a snapshot.
  const [membership] = await owned.admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id)
    values (${grant.accountId}::uuid, ${subjectId}) returning id`;
  await owned.admin`
    insert into scheduled_task_personal_resource_authorities (
      task_id, task_authority_revision, account_id, workspace_id, initiating_human_subject_id,
      owner_organization_membership_id, membership_authorization_revision, session_visibility,
      execution_digest, resource_count
    ) values (
      ${task.id}::uuid, ${locked.revision}, ${grant.accountId}::uuid, ${grant.workspaceId!}::uuid,
      ${subjectId}, ${membership!.id}::uuid, 1, 'workspace_shared', ${locked.stored}, 1
    )`;
  // Who pays is billing, not execution.
  await owned.admin`update scheduled_tasks set billing_origin = 'api' where id = ${task.id}::uuid`;
  expect(await execution()).toEqual(locked);

  // Control: a real execution change still changes the digest and revision.
  await owned.admin`
    update scheduled_tasks set agent_config = agent_config || '{"prompt":"Check again"}'::jsonb
    where id = ${task.id}::uuid`;
  const changed = await execution();
  expect(changed.stored).not.toBe(locked.stored);
  expect(changed.computed).toBe(changed.stored);
  expect(changed.revision).toBe(locked.revision + 1);
});
