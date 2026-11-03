import { test, expect } from "bun:test";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  withWorkspaceRls,
  withSessionRlsActorContext,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
} from "../src";
import { sql } from "drizzle-orm";

test("command visibility bounds backlog work and measures generic and custom sparse reads", async () => {
  const shared = await acquireSharedTestDatabase("command-visibility-plan");
  if (!shared) throw Error("missing PG");
  const client = createDb(shared.appUrl);
  try {
    const key = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "visibility-plan",
      accountExternalId: key,
      accountName: "Test",
      workspaceExternalSource: "visibility-plan",
      workspaceExternalId: key,
      workspaceName: "Test",
      subjectId: "subject:" + key,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await shared.admin`insert into session_background_commands(id,account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id,cancel_requested_at,cancel_requested_by) select id,${grant.accountId},${grant.workspaceId},${session.id},'connected_machine','stopping',${grant.workspaceId},${crypto.randomUUID()},'fixture',id::text,now(),'fixture' from (select gen_random_uuid() id from generate_series(1,36810)) seeded`;
    // Disposable planner fixture only: copy realistic session cardinality
    // without executing unrelated lifecycle writers for 20,000 synthetic rows.
    await shared.admin`alter table sessions disable trigger all`;
    await shared.admin`insert into sessions select clone.* from sessions s cross join (select gen_random_uuid() id from generate_series(1,20000)) seed cross join lateral jsonb_populate_record(null::sessions,to_jsonb(s) || jsonb_build_object('id',seed.id,'root_session_id',seed.id,'create_idempotency_key',null)) clone where s.id=${session.id}`;
    await shared.admin`alter table sessions enable trigger all`;
    await shared.admin`analyze sessions`;
    await shared.admin`analyze session_background_commands`;
    const [command] = await shared.admin`select id from session_background_commands limit 1`;
    const [coldSession] =
      await shared.admin`select id from sessions where id<>${session.id} limit 1`;
    await shared.admin`alter table session_background_commands disable trigger all`;
    await shared.admin`update session_background_commands set session_id=${coldSession!.id} where id=${command!.id}`;
    await shared.admin`alter table session_background_commands enable trigger all`;
    await shared.admin`analyze session_background_commands`;
    const [identity] =
      await shared.admin`select pg_get_userbyid(relowner) as owner,relnamespace::text as schema_oid from pg_class where oid='session_background_commands'::regclass`;
    const [old] =
      await shared.admin`select qual,with_check from pg_policies where tablename='session_background_commands' and policyname='session_visibility_isolation'`;
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

    const prefix = `session_tenancy_fence_owner_policy_active(current_user::text,${quote(identity!.owner)},${identity!.schema_oid}::oid,workspace_id,true) OR session_tenancy_fence_owner_policy_active(current_user::text,${quote(identity!.owner)},${identity!.schema_oid}::oid,workspace_id,false) OR session_id IS NULL OR EXISTS (SELECT 1 FROM sessions session_row WHERE session_row.account_id=session_background_commands.account_id AND session_row.workspace_id=session_background_commands.workspace_id AND session_row.id=session_background_commands.session_id`;
    const legacy = prefix + " OFFSET 0)";
    expect(old!.qual).not.toContain("OFFSET 0");
    expect(old!.with_check).toContain("OFFSET 0");
    for (const [label, qual] of [
      ["legacy", legacy],
      ["current", old!.qual],
    ]) {
      await shared.admin.unsafe(
        `ALTER POLICY session_visibility_isolation ON session_background_commands USING (${qual})`,
      );
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        for (const sparse of [false, true, "page"] as const) {
          await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
            withWorkspaceRls(client.db, grant.workspaceId, async (tx) => {
              await tx.execute(sql.raw(`set local plan_cache_mode=${mode}`));
              await tx.execute(
                sql.raw(
                  sparse === "page"
                    ? `prepare visibility_bench(uuid,uuid) as select id from session_background_commands where workspace_id=$1 and session_id=$2 order by started_at,id limit 50`
                    : `prepare visibility_bench(uuid,uuid) as select count(*) from session_background_commands where workspace_id=$1 and state='stopping' ${sparse ? "and id='" + command!.id + "'" : ""}`,
                ),
              );
              try {
                const rows = await tx.execute(
                  sql.raw(
                    `explain (analyze,buffers,format json) execute visibility_bench('${grant.workspaceId}','${coldSession!.id}')`,
                  ),
                );
                const p = rows[0]!["QUERY PLAN"][0];
                const scans: any[] = [];
                const visit = (node: any) => {
                  if (node["Relation Name"] === "sessions") scans.push(node);
                  for (const child of node.Plans ?? []) visit(child);
                };
                visit(p.Plan);
                expect(scans.length).toBe(1);
                expect(scans[0]["Actual Loops"]).toBe(sparse || label === "current" ? 1 : 36810);
                if (sparse && sparse !== "page") expect(scans[0]["Node Type"]).toBe("Index Scan");
                else if (label === "current")
                  expect(p.Plan["Shared Hit Blocks"]).toBeLessThan(10000);
                if (sparse === "page") {
                  expect(p.Plan["Actual Rows"]).toBe(1);
                  expect(p.Plan["Shared Hit Blocks"]).toBeLessThan(4000);
                  // Generic session pagination may hash the visible set. Keep
                  // this explicit: it is the accepted commands-only tradeoff.
                  expect(scans[0]["Node Type"]).toBe(
                    label === "current" && mode === "force_generic_plan"
                      ? "Seq Scan"
                      : "Index Scan",
                  );
                }
                console.log(
                  JSON.stringify({
                    label,
                    mode,
                    sparse,
                    executionMs: p["Execution Time"],
                    bufferHits: p.Plan["Shared Hit Blocks"],
                    sessionLoops: scans[0]["Actual Loops"],
                  }),
                );
              } finally {
                await tx.execute(sql.raw("deallocate visibility_bench"));
              }
            }),
          );
        }
      }
    }
  } finally {
    await client.close();
    await shared.release();
  }
}, 180000);

test("command visibility preserves private ownership, tenant and write policy isolation", async () => {
  const shared = await acquireSharedTestDatabase("command-visibility-isolation");
  if (!shared) throw Error("missing PG");
  const client = createDb(shared.appUrl);
  try {
    const key = crypto.randomUUID();
    const access = await ensureManagedAccessForUser(client.db, {
      userId: key,
      email: `${key}@example.test`,
      name: "Visibility owner",
    });
    const grant = access.workspaceGrants[0]!;
    await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'test') on conflict do nothing`;
    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: grant.subjectId,
    });
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: grant.subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
    const makeSession = () =>
      withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
        createSession(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          initialMessage: "",
          resources: [],
          metadata: {},
          model: "test",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: grant.subjectId },
          createdByContext: {},
        }),
      );
    const privateSession = await makeSession();
    const sharedSession = await makeSession();
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId,
      sessionId: privateSession.id,
      actorSubjectId: grant.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: crypto.randomUUID(),
    });
    const commandIds: string[] = [];
    for (const sessionId of [privateSession.id, sharedSession.id]) {
      const id = crypto.randomUUID();
      commandIds.push(id);
      await shared.admin`insert into session_background_commands(id,account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id) values(${id},${grant.accountId},${grant.workspaceId},${sessionId},'connected_machine','running',${grant.workspaceId},${crypto.randomUUID()},'fixture',${id})`;
    }
    const [policy] =
      await shared.admin`select qual,with_check from pg_policies where tablename='session_background_commands' and policyname='session_visibility_isolation'`;
    // Reintroduce only the historical optimizer fence. All capability arms and the
    // complete correlated tenant tuple come directly from the migrated policy.
    const legacy = policy!.qual.replace(
      /(session_row.id = session_background_commands.session_id\)\))/,
      "$1 OFFSET 0",
    );
    expect(legacy).not.toBe(policy!.qual);
    const outcomes: any[] = [];
    for (const qual of [legacy, policy!.qual]) {
      await shared.admin.unsafe(
        `alter policy session_visibility_isolation on session_background_commands using (${qual})`,
      );
      const reads: any[] = [];
      for (const subjectId of [grant.subjectId, "user:unrelated"]) {
        const ids = await withSessionRlsActorContext({ subjectId }, () =>
          withWorkspaceRls(client.db, grant.workspaceId, async (tx) => {
            const rows = await tx.execute(
              sql`select id from session_background_commands order by id`,
            );
            return rows.map((row: { id: string }) => row.id);
          }),
        );
        reads.push(ids);
        if (subjectId === grant.subjectId) expect(ids).toEqual([...commandIds].sort());
        else {
          expect(ids).not.toContain(commandIds[0]);
          expect(ids).toContain(commandIds[1]);
        }
      }
      const other = await bootstrapWorkspace(client.db, {
        accountExternalSource: "visibility-isolation",
        accountExternalId: crypto.randomUUID(),
        accountName: "Other",
        workspaceExternalSource: "visibility-isolation",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Other",
        subjectId: grant.subjectId,
      });
      await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
        withWorkspaceRls(client.db, other.workspaceGrants[0]!.workspaceId, async (tx) => {
          expect(
            await tx.execute(
              sql`select id from session_background_commands where session_id=${privateSession.id}`,
            ),
          ).toHaveLength(0);
        }),
      );
      const [after] =
        await shared.admin`select with_check from pg_policies where tablename='session_background_commands' and policyname='session_visibility_isolation'`;
      expect(after!.with_check).toBe(policy!.with_check);
      outcomes.push(reads);
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  } finally {
    await client.close();
    await shared.release();
  }
}, 180000);
