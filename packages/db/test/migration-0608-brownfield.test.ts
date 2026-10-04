import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { executeMigrationFile } from "../src/migrate";
import { createDb, withRestoredSessionActivityRlsContext } from "../src/database";

test("0608 upgrades an existing started session with the original deferred constraints", async () => {
  const database = await acquireOwnerMigratedTestDatabase("receiver-context-upgrade");
  if (!database) throw new Error("Owner PostgreSQL required");
  const owner = postgres(database.ownerUrl, { max: 1 });
  const directory = new URL("../drizzle/", import.meta.url);
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const client = createDb(database.adminUrl);
  try {
    await owner`select set_config('opengeni.max_nested_agent_depth','3',false),
      set_config('opengeni.nested_agent_depth_policy_source','default',false),
      set_config('opengeni.migration_application_roles','["opengeni_app"]',false)`;
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const file of (await readdir(directory))
      .filter((entry) => entry.endsWith(".sql") && entry < "0608_")
      .sort()) {
      await executeMigrationFile(owner, file, await readFile(new URL(file, directory), "utf8"), {
        preinstalledVector: true,
        environmentsEncryptionKey: new Uint8Array(32),
      });
      await owner`insert into schema_migrations(name) values(${file}) on conflict do nothing`;
    }
    // Install only legacy data before 0608. This avoids using new-schema
    // application writers or replaying a backfill after later migrations.
    await database.admin.begin(async (tx) => {
      await tx`set local session_replication_role=replica`;
      await tx`insert into managed_accounts(id,name) values(${accountId},'Upgrade fixture')`;
      await tx`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Upgrade fixture')`;
      await tx`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
      await tx`insert into workspace_session_activity_revisions(workspace_id,account_id,revision)
        values(${workspaceId},${accountId},1)`;
      await tx`insert into sessions(id,account_id,workspace_id,root_session_id,sandbox_group_id,status,initial_message,model,sandbox_backend,tool_policy,
        nested_agent_depth,effective_max_nested_agent_depth,nested_agent_depth_policy_source,reasoning_effort,latency_mode)
        values(${sessionId},${accountId},${workspaceId},${sessionId},${sessionId},'idle','Existing request','scripted-model','none',
        '{"mode":"explicit","inheritedFromSessionId":null}',0,3,'default','medium','standard')`;
      await tx`insert into session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
        status,source,position,prompt,model,reasoning_effort,sandbox_backend,initiator_kind,initiator_subject_id)
        values(${turnId},${accountId},${workspaceId},${sessionId},${eventId},'upgrade-fixture',
        'completed','user',1,'Existing request','scripted-model','medium','none','subject','upgrade-human')`;
      await tx`insert into session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,
        state,outcome,temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,
        verified_control_revision,authority_epoch,authority_visibility,mcp_approval_policies,closed_at)
        values(${attemptId},${accountId},${workspaceId},${sessionId},${turnId},1,'closed','completed',
        'upgrade-fixture','upgrade-run','upgrade-activity',1,1,'workspace_shared','{}',now())`;
      await tx`insert into session_events(id,account_id,workspace_id,session_id,turn_id,turn_generation,
        turn_attempt_id,turn_association,sequence,type,payload)
        values(${eventId},${accountId},${workspaceId},${sessionId},${turnId},1,${attemptId},'current',1,'turn.started','{}')`;
      await tx`update sessions set last_sequence=1 where id=${sessionId}`;
      await tx`insert into session_event_cursors(session_id,account_id,workspace_id,last_sequence)
        values(${sessionId},${accountId},${workspaceId},1)`;
      // Retained brownfield evidence can predate the current commit-gate proof.
      // Keep its stale marker so a clean greenfield-only migration test cannot
      // accidentally claim to cover this upgrade failure.
      await tx`update sessions set activity_revision_pending_xid=78230807 where id=${sessionId}`;
    });
    const migration = await readFile(
      new URL("0608_receiver_execution_context.sql", directory),
      "utf8",
    );
    await expect(
      executeMigrationFile(owner, "0608_receiver_execution_context.sql", migration),
    ).rejects.toThrow("pending trigger events");
    const [before] =
      await database.admin`select to_jsonb(s)-'activity_revision'-'activity_revision_pending_xid' as stable
      from sessions s where id=${sessionId}`;
    // Re-anchor only the old marker with an ordinary same-value activity touch;
    // the existing commit gate advances the workspace clock and proves the
    // final cleared row. No direct marker clearing or disabled guard is needed.
    await client.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(727458)`);
      await withRestoredSessionActivityRlsContext(
        tx,
        { accountId, workspaceId },
        async (scoped) => {
          await scoped.execute(
            sql`update sessions set updated_at=updated_at where id=${sessionId}::uuid`,
          );
        },
      );
    });
    const [after] =
      await database.admin`select to_jsonb(s)-'activity_revision'-'activity_revision_pending_xid' as stable,
      activity_revision_pending_xid,activity_revision from sessions s where id=${sessionId}`;
    expect(after).toMatchObject({
      ...before,
      activity_revision_pending_xid: null,
      activity_revision: "2",
    });
    await executeMigrationFile(owner, "0608_receiver_execution_context.sql", migration);
    const [session] =
      await database.admin`select execution_context_turn_id from sessions where id=${sessionId}`;
    expect(session!.execution_context_turn_id).toBe(turnId);
    const [role] =
      await owner`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const tables = await database.admin`select relforcerowsecurity from pg_class where oid in
      ('sessions'::regclass,'session_turns'::regclass,'session_turn_attempts'::regclass,'session_events'::regclass)`;
    expect(tables).toHaveLength(4);
    expect(tables.every((row) => row.relforcerowsecurity)).toBe(true);
  } finally {
    await client.close();
    await owner.end();
    await database.release();
  }
}, 240_000);
