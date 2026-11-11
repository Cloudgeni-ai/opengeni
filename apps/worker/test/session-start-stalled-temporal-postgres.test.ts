import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { createSessionForRequest } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  listSessionTurns,
  markSessionWorkflowWakeDelivered,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { reconcilePendingSessionWorkflowWakes } from "../src/activities/parent-wake";
import type { NotifyServices } from "../src/activities/parent-wake";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-start-stalled-temporal");
  if (!acquired) throw new Error("Session start wake regression requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Wake = Parameters<ApiRouteDeps["workflowClient"]["wakeSessionWorkflow"]>[0];

/** A Temporal frontend that accepts the call and never answers. */
function stalledTemporal() {
  const calls: Wake[] = [];
  const noop = async () => undefined;
  return {
    calls,
    client: {
      wakeSessionWorkflow: (wake: Wake) => {
        calls.push(wake);
        return new Promise<never>(() => undefined);
      },
      requestSessionWorkflowWakeDispatch: () => new Promise<never>(() => undefined),
      signalUserMessage: noop,
    },
  };
}

async function fixture(workflowClient: object) {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "stalled-temporal-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Stalled Temporal fixture",
    workspaceExternalSource: "stalled-temporal-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Stalled Temporal fixture",
    subjectId: `user:stalled-temporal:${crypto.randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  const noop = async () => undefined;
  const deps = {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      openaiAllowedModels: "scripted-model",
      openaiReasoningEffort: "low",
    }),
    bus: new MemoryEventBus(),
    workflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  return { grant, deps };
}

async function outbox(sessionId: string) {
  const [row] = await shared.admin<Array<{ wakeRevision: number; deliveredRevision: number }>>`
    select wake_revision::int as "wakeRevision", delivered_revision::int as "deliveredRevision"
    from session_workflow_wake_outbox where session_id = ${sessionId}`;
  return row;
}

const never = Symbol("create still waiting");

test("session create returns while Temporal stalls, and the outbox still starts the run", async () => {
  const temporal = stalledTemporal();
  const { grant, deps } = await fixture(temporal.client);

  // Before this change the create joined the immediate wake, so a Temporal
  // frontend that never answers held the request open indefinitely.
  const created = await Promise.race([
    createSessionForRequest(deps, grant, grant.workspaceId, {
      initialMessage: "Synthetic create; never executes a model",
      sandboxBackend: "none",
    }),
    Bun.sleep(20_000).then(() => never),
  ]);
  if (created === never) throw new Error("session create waited on the stalled Temporal wake");
  expect(created.status).toBe("queued");

  // The immediate wake still started right after the commit (normal-case
  // start latency is unchanged); it just never returned.
  expect(temporal.calls).toHaveLength(1);
  const wake = temporal.calls[0]!;
  expect(wake).toMatchObject({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: created.id,
    workflowId: `session-${created.id}`,
  });
  // The accepted turn's wake is durably owed.
  const pending = await outbox(created.id);
  expect(pending?.wakeRevision).toBe(wake.wakeRevision);
  expect(pending!.deliveredRevision).toBeLessThan(wake.wakeRevision);

  // The control worker's recovery sweep re-delivers exactly that revision
  // once Temporal answers again.
  const redelivered: Wake[] = [];
  const services = {
    db: client.db,
    wakeSessionWorkflow: async (input: Wake) => {
      redelivered.push(input);
      return await markSessionWorkflowWakeDelivered(client.db, input);
    },
  } as unknown as NotifyServices;
  const sweep = await reconcilePendingSessionWorkflowWakes(services, 1_000);
  const ours = redelivered.filter((item) => item.sessionId === created.id);
  expect(ours).toHaveLength(1);
  expect(ours[0]).toMatchObject({
    workflowId: `session-${created.id}`,
    wakeRevision: wake.wakeRevision,
  });
  expect(sweep.failed).toBe(0);
  // A queued turn keeps its wake owed until a worker claims it.
  expect((await outbox(created.id))!.deliveredRevision).toBeLessThan(wake.wakeRevision);

  // The woken workflow claims and starts the accepted initial turn.
  const [initialTurn] = await listSessionTurns(client.db, grant.workspaceId, created.id, 1);
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: created.id,
    workflowId: wake.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claimed.action).toBe("claimed");
  if (claimed.action !== "claimed") return;
  expect(claimed.turn.id).toBe(initialTurn!.id);
  // Once claimed, the next delivery acknowledges the outstanding revision.
  expect(
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: created.id,
      temporalWorkflowId: wake.workflowId,
      wakeRevision: wake.wakeRevision,
    }),
  ).toEqual({ action: "acknowledged" });
}, 60_000);

test("a failing immediate wake no longer fails an accepted session create", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const calls: Wake[] = [];
    const { grant, deps } = await fixture({
      wakeSessionWorkflow: async (wake: Wake) => {
        calls.push(wake);
        throw new Error("temporal frontend unavailable");
      },
      requestSessionWorkflowWakeDispatch: async () => undefined,
      signalUserMessage: async () => undefined,
    });
    const created = await createSessionForRequest(deps, grant, grant.workspaceId, {
      initialMessage: "Synthetic create; never executes a model",
      sandboxBackend: "none",
    });
    expect(created.status).toBe("queued");
    expect(calls).toHaveLength(1);
    const pending = await outbox(created.id);
    expect(pending?.wakeRevision).toBe(calls[0]!.wakeRevision);
    expect(pending!.deliveredRevision).toBeLessThan(calls[0]!.wakeRevision);
    const [turn] = await listSessionTurns(client.db, grant.workspaceId, created.id, 1);
    expect(turn?.status).toBe("queued");
  } finally {
    warn.mockRestore();
  }
}, 60_000);
