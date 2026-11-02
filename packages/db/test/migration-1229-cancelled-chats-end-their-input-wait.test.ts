import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migration = "1229_cancelled_chats_end_their_input_wait.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const subjectId = "user:cancelled-input-wait-repair";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let prefix: string | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("cancelled-chats-input-wait");
  if (!owned) throw new Error("Real PostgreSQL is required for the cancelled chat wait repair");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-cancelled-wait-repair-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < migration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1229 cancelled chats end their input wait", () => {
  test("clears the wait of cancelled chats only, despite FORCE RLS", async () => {
    const access = await bootstrapWorkspace(client!.db, {
      accountExternalSource: "cancelled-wait-repair-test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Cancelled wait repair",
      workspaceExternalSource: "cancelled-wait-repair-test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Cancelled wait repair",
      subjectId,
    });
    const accountId = access.defaultAccountId!;
    const workspaceId = access.defaultWorkspaceId!;
    const admin = owned!.admin;
    // Raw SQL, not the Drizzle helpers: the schema describes head, and this
    // database stops before 1229. The session triggers read tenant rows as
    // their definer, so admit this workspace the way the application does.
    const waitingChat = async (status: string) =>
      await admin.begin(async (tx) => {
        await tx`
          select set_config('opengeni.account_id', ${accountId}, true),
            set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        const [row] = await tx<{ id: string }[]>`
          insert into sessions (
            account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
            sandbox_backend, sandbox_group_id, tool_policy
          ) values (
            ${accountId}, ${workspaceId}, ${status}, 'test-model', 'medium', 'standard', 'none',
            gen_random_uuid(),
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
          )
          returning id`;
        await tx`
          update sessions set status = ${status}, input_wait_turn_id = gen_random_uuid(),
            input_wait_until = now() - interval '30 days', input_wait_reason = 'Waiting for CI',
            input_wait_set_at = now() - interval '31 days'
          where id = ${row!.id}`;
        return row!;
      });
    const cancelled = await waitingChat("cancelled");
    const idle = await waitingChat("idle");

    await migrate(owned!.ownerUrl);

    const rows = await admin<{ id: string; waiting: boolean; reason: string | null }[]>`
      select id, input_wait_until is not null as waiting, input_wait_reason as reason
      from sessions where workspace_id = ${workspaceId}`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(cancelled.id)).toMatchObject({ waiting: false, reason: null });
    expect(byId.get(idle.id)).toMatchObject({ waiting: true, reason: "Waiting for CI" });

    const [state] = await admin<{ forced: boolean; fenced: boolean; applied: boolean }[]>`
      select c.relforcerowsecurity as forced,
        exists(select 1 from pg_trigger t where t.tgrelid = c.oid
          and t.tgname = 'session_tenancy_workspace_fence' and t.tgenabled <> 'D') as fenced,
        exists(select 1 from schema_migrations where name = ${migration}) as applied
      from pg_class c where c.oid = 'public.sessions'::regclass`;
    expect(state).toEqual({ forced: true, fenced: true, applied: true });
  }, 180_000);
});
