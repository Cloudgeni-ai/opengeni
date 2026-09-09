import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItems,
  settleConnectedMachineSessionBackgroundCommand,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import {
  getSessionBackgroundCommand,
  insertConnectedMachineSessionBackgroundCommandInTransaction,
  observeSessionBackgroundCommandCompletion,
  readSessionBackgroundCommandOutput,
} from "../src/session-background-commands";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("command-observation-claim");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command observation",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command observation",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const sessionInput = {
    ...scope,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const session = await createSession(client.db, sessionInput);
  const identity = { ...scope, sessionId: session.id, commandId: crypto.randomUUID() };
  const provider = {
    controlWorkspaceId: scope.workspaceId,
    enrollmentId: crypto.randomUUID(),
    connectionInstanceId: crypto.randomUUID(),
    opId: crypto.randomUUID(),
  };
  await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
    insertConnectedMachineSessionBackgroundCommandInTransaction(db, {
      ...identity,
      ...provider,
      command: "printf output",
    }),
  );
  await settleConnectedMachineSessionBackgroundCommand(client.db, {
    ...identity,
    ...provider,
    outcome: "exited",
    exitCode: 0,
    reason: "process exited",
  });
  return { identity, sessionInput };
}

test("terminal reads preserve notification and history delivered by the ordinary claim API", async () => {
  const { identity } = await fixture();
  const claim = await claimSessionWorkForAttempt(client.db, identity.workspaceId, {
    sessionId: identity.sessionId,
    workflowId: `session-${identity.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claim.action).toBe("claimed");
  const updates = () => shared.admin`
    select * from session_system_updates where workspace_id = ${identity.workspaceId}
      and session_id = ${identity.sessionId} and source_id = ${identity.commandId}`;
  const before = await updates();
  expect(before).toHaveLength(1);
  expect(before[0]!.state).toBe("delivered");
  expect(before[0]!.delivered_history_item_id).not.toBeNull();
  const history = await getActiveSessionHistoryItems(
    client.db,
    identity.workspaceId,
    identity.sessionId,
  );
  expect(history.length).toBeGreaterThan(0);
  expect(JSON.stringify(history)).toContain(identity.commandId);
  const first = await readSessionBackgroundCommandOutput(client.db, identity);
  expect(first).toMatchObject({ terminal: true, state: "exited", exitCode: 0 });
  expect(first.completionObservedAt).toEqual(expect.any(String));
  expect(await readSessionBackgroundCommandOutput(client.db, identity)).toEqual(first);
  await observeSessionBackgroundCommandCompletion(client.db, identity);
  expect(await updates()).toEqual(before);
  expect(
    await getActiveSessionHistoryItems(client.db, identity.workspaceId, identity.sessionId),
  ).toEqual(history);
});

test("an existing sibling session cannot read or acknowledge another session's command", async () => {
  const { identity, sessionInput } = await fixture();
  const sibling = await createSession(client.db, sessionInput);
  const wrong = { ...identity, sessionId: sibling.id };
  await expect(readSessionBackgroundCommandOutput(client.db, wrong)).rejects.toThrow("not found");
  expect(await observeSessionBackgroundCommandCompletion(client.db, wrong)).toBeNull();
  expect(await getSessionBackgroundCommand(client.db, wrong)).toBeNull();
  expect((await getSessionBackgroundCommand(client.db, identity))?.completionObservedAt).toBeNull();
  const rows = await shared.admin`
    select state from session_system_updates where workspace_id = ${identity.workspaceId}
      and session_id = ${identity.sessionId} and source_id = ${identity.commandId}`;
  expect(rows).toMatchObject([{ state: "pending" }]);
});
