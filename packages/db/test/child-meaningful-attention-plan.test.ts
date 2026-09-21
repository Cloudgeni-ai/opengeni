import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bootstrapWorkspace, createDb, createSession, withWorkspaceSubjectRls } from "../src";
import {
  childLifecycleEvidenceCandidatesSql,
  meaningfulSessionSequenceSql,
} from "../src/session-meaningful-events";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("child-meaningful-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("generic and custom application-RLS plans bound cleanup tails and oversized meaningful history", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Attention plans",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Attention plans",
    subjectId: `attention-plan-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const defaults = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const target = await createSession(client.db, defaults);
  // Synthetic fixture writes use only the disposable harness administrator.
  // A long oversized meaningful run followed by cleanup must not be scanned
  // looking for 32 *eligible* payloads, nor for the raw event tip.
  await shared.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
    select ${grant.accountId},${grant.workspaceId},${target.id},n,
      case when n <= 2000 then 'turn.completed' else 'sandbox.box.terminated' end,
      case when n <= 2000 then jsonb_build_object('output',repeat('oversized answer ',1024)) else '{}'::jsonb end
    from generate_series(1,12000) n`;
  for (let i = 0; i < 8; i++) {
    const sibling = await createSession(client.db, defaults);
    await shared.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      select ${grant.accountId},${grant.workspaceId},${sibling.id},n,'agent.message.delta',
        jsonb_build_object('text','unrelated raw history') from generate_series(1,2000) n`;
  }
  await shared.admin`analyze session_events`;
  const dialect = new PgDialect();
  const queries = [
    {
      name: "attention_frontier",
      maximumRows: 1,
      query: dialect.sqlToQuery(
        sql`select ${meaningfulSessionSequenceSql(sql`${grant.workspaceId}::uuid`, sql`${target.id}::uuid`)}`,
      ),
    },
    {
      name: "attention_lifecycle",
      maximumRows: 32,
      query: dialect.sqlToQuery(
        childLifecycleEvidenceCandidatesSql(
          sql`${grant.workspaceId}::uuid`,
          sql`${target.id}::uuid`,
        ),
      ),
    },
  ];
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    for (const { name, query, maximumRows } of queries) {
      await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, async (tx) => {
        const posture = await tx.execute(
          sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
        );
        expect(posture[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
        await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
        // PREPARE really exercises the generic/custom cache decision. An
        // unprepared EXPLAIN plus enable_seqscan=off would not prove this path.
        await tx.execute(sql.raw(`prepare ${name}(uuid,uuid) as ${query.sql}`));
        try {
          const rows = await tx.execute(
            sql.raw(
              `explain (analyze,buffers,format json) execute ${name}('${grant.workspaceId}'::uuid,'${target.id}'::uuid)`,
            ),
          );
          const plan = rows[0]?.["QUERY PLAN"];
          const eventNodes: Record<string, unknown>[] = [];
          const walk = (value: unknown): void => {
            if (Array.isArray(value)) {
              value.forEach(walk);
              return;
            }
            if (!value || typeof value !== "object") return;
            const node = value as Record<string, unknown>;
            if (node["Relation Name"] === "session_events") eventNodes.push(node);
            Object.values(node).forEach(walk);
          };
          walk(plan);
          expect(eventNodes).toHaveLength(1);
          const node = eventNodes[0]!;
          expect(node["Index Name"]).toBe("session_events_meaningful_attention_idx");
          expect(node["Actual Rows"]).toBe(maximumRows);
          expect(Number(node["Rows Removed by Filter"] ?? 0)).toBe(0);
          expect(
            Number(node["Shared Hit Blocks"] ?? 0) + Number(node["Shared Read Blocks"] ?? 0),
          ).toBeLessThan(512);
        } finally {
          await tx.execute(sql.raw(`deallocate ${name}`));
        }
      });
    }
  }
}, 180_000);
