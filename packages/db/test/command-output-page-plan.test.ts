import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { bootstrapWorkspace, createDb, createSession, withRlsContext } from "../src";
import {
  commandOutputPageQuery,
  readSessionBackgroundCommandOutput,
} from "../src/session-background-commands";
import { commandOutputClientEventIdPrefix } from "../src/session-command-output";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("command-output-page-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const OTHER_CHUNKS = 3000;
const TARGET_CHUNKS = 5;

test("reading one command's output does not walk the session's other command output", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command output plans",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command output plans",
    subjectId: `command-output-plan-${suffix}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  const commandId = crypto.randomUUID();
  const identity = { accountId, workspaceId, sessionId: session.id, commandId };
  await shared.admin`insert into session_background_commands ${shared.admin({
    id: commandId,
    account_id: accountId,
    workspace_id: workspaceId,
    session_id: session.id,
    provider: "connected_machine",
    state: "running",
    control_workspace_id: workspaceId,
    enrollment_id: crypto.randomUUID(),
    connection_instance_id: "launch",
    op_id: commandId,
  })}`;
  // Synthetic history written by the disposable harness administrator with
  // writer triggers off: a long session whose other commands produced a lot of
  // output, then the target command's few chunks at the end, in the exact
  // client event id shape the output writer uses.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const [base] = await tx<{ last: number }[]>`
      select coalesce(max(sequence), 0)::int as last from session_events
      where workspace_id = ${workspaceId}::uuid and session_id = ${session.id}::uuid`;
    const start = Number(base!.last);
    await tx`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload, client_event_id
      ) select ${accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid, ${start} + other.n,
        'sandbox.command.output.delta',
        jsonb_build_object('commandId', other.id::text, 'stream', 'stdout',
          'streamFidelity', 'separate', 'chunk', 'other output ' || other.n),
        'command-output:' || other.id::text || ':' || gen_random_uuid()::text || ':stdout:0'
      from (select n, gen_random_uuid() as id from generate_series(1, ${OTHER_CHUNKS}) n) other`;
    await tx`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload, client_event_id
      ) select ${accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
        ${start + OTHER_CHUNKS} + n, 'sandbox.command.output.delta',
        jsonb_build_object('commandId', ${commandId}::text, 'stream', 'stdout',
          'streamFidelity', 'separate', 'chunk', 'target ' || n || E'\n'),
        ${commandOutputClientEventIdPrefix(commandId)} || gen_random_uuid()::text || ':stdout:0'
      from generate_series(1, ${TARGET_CHUNKS}) n`;
    await tx`update sessions set last_sequence = ${start + OTHER_CHUNKS + TARGET_CHUNKS}
      where id = ${session.id}::uuid`;
  });
  await shared.admin`analyze session_events`;

  const output = await readSessionBackgroundCommandOutput(client.db, identity);
  expect(output.chunks.map((chunk) => chunk.chunk).join("")).toBe(
    Array.from({ length: TARGET_CHUNKS }, (_, index) => `target ${index + 1}\n`).join(""),
  );
  expect(output.hasMore).toBe(false);

  const query = commandOutputPageQuery(client.db, identity, 0).toSQL();
  const literal = (value: unknown) =>
    typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    await withRlsContext(client.db, identity, async (tx) => {
      await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      // PREPARE exercises the real generic/custom plan-cache decision.
      await tx.execute(sql.raw(`prepare command_output_plan as ${query.sql}`));
      let plan: unknown;
      try {
        const explained = await tx.execute(
          sql.raw(
            `explain (analyze, buffers, format json) execute command_output_plan(${query.params
              .map(literal)
              .join(", ")})`,
          ),
        );
        plan = explained[0]?.["QUERY PLAN"];
        const root = (plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
        const eventScans: Record<string, unknown>[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) return value.forEach(walk);
          if (!value || typeof value !== "object") return;
          const node = value as Record<string, unknown>;
          if (node["Relation Name"] === "session_events") eventScans.push(node);
          Object.values(node).forEach(walk);
        };
        walk(root);
        expect(eventScans).toHaveLength(1);
        // Only the target command's chunks are visited; the session's other
        // command output is never read or filtered row by row.
        expect(eventScans[0]!["Actual Rows"]).toBe(TARGET_CHUNKS);
        expect(Number(eventScans[0]!["Rows Removed by Filter"] ?? 0)).toBe(0);
        expect(
          Number(root["Shared Hit Blocks"] ?? 0) + Number(root["Shared Read Blocks"] ?? 0),
        ).toBeLessThan(100);
      } catch (error) {
        console.error("command output plan failure", JSON.stringify({ mode, plan }));
        throw error;
      } finally {
        await tx.execute(sql.raw("deallocate command_output_plan"));
      }
    });
  }
}, 180_000);
