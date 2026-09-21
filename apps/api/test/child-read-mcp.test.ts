import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionForSubject,
  grantWorkspaceAccess,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("child-read-mcp");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(output = "Whole final answer") {
  const human = `user:child-read-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Child read",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Child read",
    subjectId: human,
  });
  const workspaceGrant = access.workspaceGrants[0]!;
  const { accountId, workspaceId } = workspaceGrant;
  const otherHuman = `user:other-${crypto.randomUUID()}`;
  await grantWorkspaceAccess(client.db, {
    accountId,
    workspaceId,
    subjectId: otherHuman,
    permissions: ["sessions:read"],
  });
  const defaults = {
    accountId,
    workspaceId,
    initialMessage: "work",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject" as const, subjectId: human },
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const parent = await createSession(client.db, defaults);
  await initializeSessionStartAtomically(client.db, {
    accountId,
    workspaceId,
    sessionId: parent.id,
    clientEventId: `initial:${parent.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: parent.id,
    workflowId: `session-${parent.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("parent was not claimed");
  const child = await createSession(client.db, {
    ...defaults,
    parentSessionId: parent.id,
    createdByActor: {
      type: "agent_attempt",
      sessionId: parent.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  });
  await appendSessionEvents(client.db, workspaceId, child.id, [
    { type: "turn.completed", payload: { output } },
  ]);
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId: "worker:first-party-mcp",
    principalKind: "agent_attempt",
    permissions: ["sessions:read"],
    metadata: {
      sessionId: parent.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: ["session_get", "session_events", "session_wait"],
    },
  };
  const noop = async () => undefined;
  const mcp = buildOpenGeniMcpServer(
    {
      db: client.db,
      settings: testSettings({ databaseUrl: shared.appUrl }),
      bus: new MemoryEventBus(),
      workflowClient: {
        signalUserMessage: noop,
        wakeSessionWorkflow: noop,
        requestSessionWorkflowWakeDispatch: noop,
        signalApprovalDecision: noop,
        signalSessionControl: noop,
        syncScheduledTask: noop,
        deleteScheduledTaskSchedule: noop,
        triggerScheduledTask: noop,
      },
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: noop },
      getDocumentServices: () => ({}),
    } as unknown as ApiRouteDeps,
    grant,
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const tools = (
      mcp as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
          }
        >;
      }
    )._registeredTools;
    const result = await tools[name]!.handler(args, {});
    const text = (result as { content: { text: string }[] }).content[0]!.text;
    return JSON.parse(text);
  };
  const unread = async (subjectId = human) =>
    (await getSessionForSubject(client.db, workspaceId, child.id, subjectId))!.unread;
  return { call, unread, otherHuman, workspaceId, child };
}

test("actual session_events acknowledges the exact parent turn human; status reads do not", async () => {
  const f = await fixture();
  await f.call("session_get", { sessionId: f.child.id });
  expect(await f.unread()).toBe(true);
  const page = await f.call("session_events", { sessionId: f.child.id, view: "results" });
  expect(page.events[0].text).toBe("Whole final answer");
  expect(await f.unread()).toBe(false);
  expect(await f.unread(f.otherHuman)).toBe(true);
}, 60_000);

test("actual fragment and truncated wait reads cannot clear a large unseen answer", async () => {
  const f = await fixture("large answer ".repeat(4000));
  const page = await f.call("session_events", { sessionId: f.child.id, view: "results" });
  expect(page.nextCursor).toBeTruthy();
  expect(await f.unread()).toBe(true);
  await f.call("session_wait", {
    targets: [{ sessionId: f.child.id, afterSequence: 0 }],
    waitFor: "completion",
    maxWaitSeconds: 1,
  });
  expect(await f.unread()).toBe(true);
}, 60_000);

test("actual complete wait result followed by cleanup stays read; a new answer reopens", async () => {
  const f = await fixture();
  const result = await f.call("session_wait", {
    targets: [{ sessionId: f.child.id, afterSequence: 0 }],
    waitFor: "completion",
    maxWaitSeconds: 1,
  });
  expect(result.changed[0].events[0].text).toBe("Whole final answer");
  expect(await f.unread()).toBe(false);
  await appendSessionEvents(client.db, f.workspaceId, f.child.id, [
    { type: "sandbox.box.terminated", payload: {} },
    { type: "workspace.revision.captured", payload: {} },
    { type: "turn.event.rejected_late", payload: { originalType: "turn.completed" } },
  ]);
  expect(await f.unread()).toBe(false);
  await appendSessionEvents(client.db, f.workspaceId, f.child.id, [
    { type: "agent.message.completed", payload: { text: "New answer" } },
  ]);
  expect(await f.unread()).toBe(true);
}, 60_000);
