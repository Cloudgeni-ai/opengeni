import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { provisionRoles } from "../src/provision-roles";
import { createDb, bootstrapWorkspace, createSession, appendSessionEvents } from "../src";

test("rolling Teams wake preserves an existing custom event writer before new-role provisioning", async () => {
  const shared = await acquireSharedTestDatabase("teams-rolling-wake");
  if (!shared) throw new Error("Real PostgreSQL required");
  const role = `teams_writer_${crypto.randomUUID().replaceAll("-", "")}`;
  const password = crypto.randomUUID();
  let client: ReturnType<typeof createDb> | null = null;
  try {
    // Give this isolated clone a fully provisioned pre-migration runtime role.
    // Dropping only the new Teams objects models the schema just before 0924.
    await provisionRoles(shared.adminUrl, { appRole: role, appPassword: password });
    const url = new URL(shared.appUrl);
    url.username = role;
    url.password = password;
    client = createDb(url.toString());
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "teams-rolling",
      accountExternalId: crypto.randomUUID(),
      accountName: "Rolling",
      workspaceExternalSource: "teams-rolling",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Rolling",
      subjectId: `user:${crypto.randomUUID()}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Rolling",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await shared.admin.unsafe(
      "drop function opengeni_private.wake_teams_route_for_session_event() cascade",
    );
    await shared.admin.unsafe(
      "drop table teams_bot_inbox,teams_bot_outbox,teams_bot_routes,teams_bot_links,teams_bot_proofs,teams_bot_installations cascade",
    );
    const migration = await readFile(
      new URL("../drizzle/0924_teams_conversations.sql", import.meta.url),
      "utf8",
    );
    await shared.admin.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    // Deliberately DO NOT provision the role after the migration.
    const [privilege] = await shared.admin`select
    has_table_privilege(${role},'teams_bot_routes','SELECT') as read,
    has_table_privilege(${role},'teams_bot_routes','UPDATE') as broad_update,
    has_column_privilege(${role},'teams_bot_routes','relevant_event_sequence','UPDATE') as wake_update,
    has_column_privilege(${role},'teams_bot_routes','subject_id','UPDATE') as owner_update,
    has_table_privilege(${role},'teams_bot_inbox','SELECT') as inbox_read,
    has_function_privilege(${role},'opengeni_private.wake_teams_route_for_session_event()','EXECUTE') as call`;
    expect(privilege).toMatchObject({
      read: true,
      broad_update: false,
      wake_update: true,
      owner_update: false,
      inbox_read: false,
      call: false,
    });
    const tenant = crypto.randomUUID(),
      actor = crypto.randomUUID();
    await shared.admin`insert into teams_bot_installations(account_id,workspace_id,tenant_id) values(${grant.accountId},${grant.workspaceId},${tenant})`;
    await shared.admin`insert into teams_bot_routes(account_id,workspace_id,tenant_id,route_id,generation,actor_id,subject_id,personal,conversation_id,service_url,bot_id,session_id)
   select ${grant.accountId},${grant.workspaceId},${tenant},'rolling-route',generation,${actor},${grant.subjectId},true,'19:rolling','https://smba.trafficmanager.net/emea/','28:bot',${session.id} from teams_bot_installations where tenant_id=${tenant}`;
    const [event] = await appendSessionEvents(client.db, grant.workspaceId, session.id, [
      { type: "turn.completed", payload: { output: "Rolling reply" } },
    ]);
    const [wake] =
      await shared.admin`select relevant_event_sequence from teams_bot_routes where route_id='rolling-route'`;
    expect(Number(wake!.relevant_event_sequence)).toBe(event!.sequence);
    expect(
      (
        await shared.admin`select prosecdef from pg_proc where oid='opengeni_private.wake_teams_route_for_session_event()'::regprocedure`
      )[0]!.prosecdef,
    ).toBe(false);
  } finally {
    await client?.close();
    // Role names are unique to this test; clean only grants in this exact clone.
    await shared.admin.unsafe(`drop owned by "${role}"`);
    await shared.admin.unsafe(`drop role if exists "${role}"`);
    await shared.release();
  }
}, 180_000);
