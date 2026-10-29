/** Cost of migration 1105's session_events trigger on the append path.
 * bun packages/db/test/workspace-activity-events.bench.ts [rows=2000] [runs=5]
 * Uses only the disposable PostgreSQL fixture, never a live application database.
 *
 * Each case appends `rows` session_events in one INSERT ... SELECT as the
 * application role under workspace row security, with every other
 * session_events trigger active, and reports microseconds per row. "off"
 * disables only the 1105 trigger, so the difference is its whole cost.
 */
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createEventSource,
  createSession,
  enqueueSessionTurn,
  withWorkspaceRls,
} from "../src";
import { rawRows } from "../src/database";
import { migrate } from "../src/migrate";

const rows = Number(process.argv[2] ?? 2000);
const runs = Number(process.argv[3] ?? 5);
if (!Number.isInteger(rows) || rows < 1 || rows > 100_000 || !Number.isInteger(runs) || runs < 1)
  throw new Error("Expected 1..100000 rows and at least one run");

const shared = await acquireSharedTestDatabase("workspace-activity-events-bench");
if (!shared) throw new Error("Real PostgreSQL is required");
const client = createDb(shared.appUrl);
try {
  await migrate(shared.adminUrl);
  const suffix = crypto.randomUUID();
  const subjectId = `subject-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench",
    accountExternalId: suffix,
    accountName: "Bench",
    workspaceExternalSource: "bench",
    workspaceExternalId: suffix,
    workspaceName: "Bench",
    subjectId,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Bench",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    visibility: "workspace_shared",
    subjectId,
    createdBy: { kind: "subject", subjectId },
  } as Parameters<typeof createSession>[1]);
  const turn = await enqueueSessionTurn(client.db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${session.id}`,
    source: "api",
    prompt: "Bench",
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "service", subjectId: "host" },
  });
  // Appends must continue the session's event cursor exactly.
  const [cursor] = await shared.admin<{ last_sequence: number }[]>`
    select last_sequence from sessions where id = ${session.id}`;
  let sequence = Number(cursor?.last_sequence ?? 0);
  const append = async (type: string) => {
    const from = sequence;
    sequence += rows;
    const started = performance.now();
    await withWorkspaceRls(client.db, workspaceId, (scoped) =>
      rawRows(
        scoped,
        sql`insert into session_events (account_id, workspace_id, session_id, turn_id, sequence,
            type, payload)
          select ${accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid, ${turn.id}::uuid,
            ${from}::integer + step, ${type}, '{"output":"A short final answer."}'::jsonb
          from generate_series(1, ${rows}::integer) step`,
      ),
    );
    return ((performance.now() - started) * 1000) / rows;
  };
  const trigger = async (enabled: boolean) =>
    await shared.admin.unsafe(
      `alter table session_events ${enabled ? "enable" : "disable"} trigger session_events_workspace_activity_v1`,
    );
  const cases = [
    {
      name: "ignored type (agent.message.delta), trigger off",
      type: "agent.message.delta",
      on: false,
    },
    {
      name: "ignored type (agent.message.delta), trigger on",
      type: "agent.message.delta",
      on: true,
    },
    { name: "turn.completed, trigger off", type: "turn.completed", on: false },
    { name: "turn.completed, trigger on, nobody listens", type: "turn.completed", on: true },
  ];
  const measure = async (list: typeof cases) => {
    const times: Record<string, number[]> = {};
    for (let iteration = 0; iteration <= runs; iteration++) {
      for (const entry of list) {
        await trigger(entry.on);
        const perRow = await append(entry.type);
        if (iteration > 0) (times[entry.name] ??= []).push(perRow);
      }
    }
    await trigger(true);
    return times;
  };
  const quiet = await measure(cases);
  await createEventSource(client.db, {
    accountId,
    workspaceId,
    createdBySubjectId: subjectId,
    kind: "workspace",
    name: "This workspace",
    ownerSubjectId: subjectId,
    visibility: "private",
  });
  const listening = await measure([
    {
      name: "ignored type (agent.message.delta), trigger on, someone listens",
      type: "agent.message.delta",
      on: true,
    },
    { name: "turn.completed, trigger off, someone listens", type: "turn.completed", on: false },
    {
      name: "turn.completed, trigger on, someone listens (writes a fact)",
      type: "turn.completed",
      on: true,
    },
  ]);
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  for (const [name, values] of Object.entries({ ...quiet, ...listening })) {
    console.log(
      JSON.stringify({
        case: name,
        rows,
        runs,
        medianMicrosecondsPerRow: Number(median(values).toFixed(1)),
        runsMicrosecondsPerRow: values.map((value) => Number(value.toFixed(1))),
      }),
    );
  }
} finally {
  await client.close();
  await shared.release();
}
