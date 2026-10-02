import { expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  withWorkspaceSessionActivityRls,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

test("non-bypass owner backfills exact attention, refuses live writers, and keeps legacy appends compatible", async () => {
  const shared = await acquireOwnerMigratedTestDatabase("attention-cursor-migration");
  if (!shared) throw new Error("Real non-bypass owner PostgreSQL required");
  const owner = postgres(shared.ownerUrl, { max: 1 });
  const adminClient = createDb(shared.adminUrl, { max: 1 });
  const appUrl = new URL(shared.adminUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = shared.appPassword;
  let app: ReturnType<typeof postgres> | undefined;
  try {
    await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(shared.adminUrl, {
      appRole: "opengeni_app",
      appPassword: shared.appPassword,
      rlsStrategy: "force",
    });
    const id = crypto.randomUUID();
    const access = await bootstrapWorkspace(adminClient.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Migration fixture",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Migration fixture",
      subjectId: `test:${id}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(adminClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Synthetic request",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const original = await Bun.file(
      new URL("../drizzle/0379_session_event_raw_lane_activation.sql", import.meta.url),
    ).text();
    const start = original.indexOf(
      "CREATE OR REPLACE FUNCTION advance_session_event_cursors_for_inserted_events()",
    );
    const end =
      original.indexOf("$advance_session_event_cursors$;", start) +
      "$advance_session_event_cursors$;".length;
    await owner.begin(async (tx) => {
      await tx.unsafe(original.slice(start, end));
      await tx`alter function advance_session_event_cursors_for_inserted_events() set search_path = pg_catalog, public, pg_temp`;
      await tx`alter table session_event_cursors drop column last_meaningful_sequence`;
    });
    await withWorkspaceSessionActivityRls(adminClient.db, grant.workspaceId, async (tx) => {
      await tx.execute(sql`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      values (${grant.accountId},${grant.workspaceId},${session.id},1,'agent.message.completed','{"text":"Answer"}'::jsonb),
        (${grant.accountId},${grant.workspaceId},${session.id},2,'agent.message.completed','{"text":"Progress","phase":"commentary"}'::jsonb)`);
      await tx.execute(sql`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      select ${grant.accountId},${grant.workspaceId},${session.id},n,'agent.message.delta','{"text":"token"}'::jsonb
      from generate_series(3,514) n`);
    });
    const migration = await Bun.file(
      new URL("../drizzle/0585_session_attention_cursor.sql", import.meta.url),
    ).text();
    const apply = () =>
      owner.begin(async (tx) => {
        await tx`select set_config('opengeni.migration_application_roles','["opengeni_app"]',true)`;
        await tx.unsafe(migration);
      });
    app = postgres(appUrl.toString(), { max: 1 });
    await app`select 1`;
    await expect(apply()).rejects.toThrow("requires stopped application roles");
    expect(
      await owner`select column_name from information_schema.columns where table_name='session_event_cursors' and column_name='last_meaningful_sequence'`,
    ).toHaveLength(0);
    await app.end();
    app = undefined;
    await apply();
    const [backfilled] = await shared.admin`select last_sequence,last_meaningful_sequence,revision
      from session_event_cursors where session_id=${session.id}`;
    expect(backfilled).toEqual({ last_sequence: 514, last_meaningful_sequence: 1, revision: "2" });
    // An older writer uses the wide semantic cursor (2), which trails raw
    // tokens. The existing normalizer rebases its event before both frontiers
    // advance in the same statement trigger.
    await withWorkspaceSessionActivityRls(adminClient.db, grant.workspaceId, (tx) =>
      tx.execute(sql`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      values(${grant.accountId},${grant.workspaceId},${session.id},3,'turn.failed','{}'::jsonb)`),
    );
    const [advanced] =
      await shared.admin`select last_sequence,last_meaningful_sequence from session_event_cursors where session_id=${session.id}`;
    expect(advanced).toEqual({ last_sequence: 515, last_meaningful_sequence: 515 });
    const force = await owner`select relname,relforcerowsecurity from pg_class
      where oid in ('session_events'::regclass,'session_event_cursors'::regclass)`;
    expect(force.every((row) => row.relforcerowsecurity)).toBe(true);
    const [routine] =
      await owner`select proconfig,proacl from pg_proc where oid='advance_session_event_cursors_for_inserted_events()'::regprocedure`;
    expect(routine!.proconfig).toContain("search_path=pg_catalog, public, pg_temp");
    expect(String(routine!.proacl)).not.toMatch(/(?:^|[,{])=X\//);
  } finally {
    await app?.end();
    await adminClient.close();
    await owner.end();
    await shared.release();
  }
}, 240_000);
