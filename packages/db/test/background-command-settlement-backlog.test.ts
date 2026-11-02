import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  settleConnectedMachineSessionBackgroundCommand,
  type Database,
} from "../src";
import { UNREACHABLE_MACHINE_STOP_REQUESTER } from "../src/session-background-commands";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("command-settlement-backlog");
  if (!acquired) throw new Error("PostgreSQL application-role fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

// Observe real SQL through nested transaction scopes, without replacing results.
function observe(db: Database, queries: string[]): Database {
  const dialect = new PgDialect();
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (run: (tx: Database) => Promise<unknown>, config?: unknown) =>
          target.transaction((tx) => run(observe(tx, queries)), config as never);
      }
      if (property === "execute") {
        return (query: Parameters<Database["execute"]>[0]) => {
          queries.push(typeof query === "string" ? query : dialect.sqlToQuery(query.getSQL()).sql);
          return target.execute(query);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("settling a command in an incident-sized backlog never recounts the backlog under its session lock", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command backlog",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command backlog",
    subjectId: `subject:${suffix}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const enrollmentId = crypto.randomUUID();
  const connectionInstanceId = "incident-backlog-instance";
  const commandCount = 36_810;
  // Disposable administrator seeds the observed incident shape. Every lifecycle
  // operation below runs as the restricted application role with normal RLS.
  await shared.admin`
    insert into session_background_commands (
      id, account_id, workspace_id, session_id, provider, state,
      control_workspace_id, enrollment_id, connection_instance_id, op_id,
      cancel_requested_at, cancel_requested_by
    ) select id, ${accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid,
      'connected_machine', 'stopping', ${workspaceId}::uuid, ${enrollmentId}::uuid,
      ${connectionInstanceId}, id::text, now(), ${UNREACHABLE_MACHINE_STOP_REQUESTER}
    from (select gen_random_uuid() as id from generate_series(1, ${commandCount})) seeded`;
  const commands = await shared.admin<{ id: string }[]>`
    select id from session_background_commands where session_id = ${session.id} limit 2`;
  const queries: string[] = [];
  const measured = observe(client.db, queries);
  for (const command of commands) {
    const result = await settleConnectedMachineSessionBackgroundCommand(measured, {
      accountId,
      workspaceId,
      sessionId: session.id,
      commandId: command.id,
      controlWorkspaceId: workspaceId,
      enrollmentId,
      connectionInstanceId,
      opId: command.id,
      outcome: "exited",
      exitCode: 130,
      reason: "op_cancelled",
    });
    expect(result?.command).toMatchObject({ id: command.id, state: "exited", exitCode: 130 });
    expect(result?.events.map((event) => event.type)).toEqual(["session.command.finished"]);
    expect(result?.wakes).toEqual([]);
  }
  // No wall-clock threshold: this catches the expensive full projection even on
  // fast hosts, without making shared CI scheduling part of correctness.
  expect(
    queries.filter(
      (query) =>
        /count\s*\(/i.test(query) &&
        /session_background_commands|session_attempt_interruptions/i.test(query),
    ),
  ).toEqual([]);
  const [remaining] = await shared.admin<{ count: number }[]>`
    select count(*)::integer as count from session_background_commands
    where session_id = ${session.id} and state = 'stopping'`;
  expect(remaining?.count).toBe(commandCount - 2);
}, 60_000);
