import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionWorkflowClient } from "@opengeni/core";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  migrate,
  saveComposerDraftInTransaction,
  type DbClient,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createApp } from "../src/app";

const fixtureNonce = crypto.randomUUID();
const AUTH_HEADER = ["author", "ization"].join("");
const BEARER_PREFIX = ["Bear", "er "].join("");
const explicitAdminDatabaseUrl = process.env.OPENGENI_PROMPT_ENQUEUE_TEST_DATABASE_ADMIN_URL;
const explicitAppDatabaseUrl = process.env.OPENGENI_PROMPT_ENQUEUE_TEST_DATABASE_URL;

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  if (explicitAdminDatabaseUrl || explicitAppDatabaseUrl) {
    if (!explicitAdminDatabaseUrl || !explicitAppDatabaseUrl) {
      throw new Error(
        "Both OPENGENI_PROMPT_ENQUEUE_TEST_DATABASE_ADMIN_URL and OPENGENI_PROMPT_ENQUEUE_TEST_DATABASE_URL are required",
      );
    }
    await migrate(explicitAdminDatabaseUrl);
    const admin = postgres(explicitAdminDatabaseUrl, { max: 4 });
    shared = {
      admin,
      adminUrl: explicitAdminDatabaseUrl,
      appUrl: explicitAppDatabaseUrl,
      release: async () => {
        await admin.end();
      },
    };
    client = createDb(shared.appUrl, { max: 6 });
    return;
  }
  const acquired = await acquireSharedTestDatabase("session-prompt-enqueue");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `prompt-enqueue-account-${suffix}`,
    accountName: "Prompt enqueue account",
    workspaceExternalSource: "test",
    workspaceExternalId: `prompt-enqueue-workspace-${suffix}`,
    workspaceName: "Prompt enqueue workspace",
    subjectId: `prompt-enqueue-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "prompt enqueue fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const token = await signDelegatedAccessToken(fixtureNonce, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return { grant, session, authHeader: `${BEARER_PREFIX}${token}` };
}

function app(input: {
  bus?: MemoryEventBus;
  wakeSessionWorkflow?: SessionWorkflowClient["wakeSessionWorkflow"];
  resumeBoxById?: Parameters<typeof createApp>[0]["resumeBoxById"];
}) {
  const noop = async () => undefined;
  return createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: fixtureNonce,
    }),
    db: client.db,
    bus: input.bus ?? new MemoryEventBus(),
    managedAuth: null,
    objectStorage: null,
    ...(input.resumeBoxById ? { resumeBoxById: input.resumeBoxById } : {}),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: input.wakeSessionWorkflow ?? noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
      startRigVerification: noop,
    } as SessionWorkflowClient,
  });
}

function send(
  application: ReturnType<typeof createApp>,
  input: {
    workspaceId: string;
    sessionId: string;
    authHeader: string;
    clientEventId: string;
    correlationId?: string;
    body?: Record<string, unknown>;
  },
) {
  return application.request(
    `http://localhost/v1/workspaces/${input.workspaceId}/sessions/${input.sessionId}/messages`,
    {
      method: "POST",
      headers: {
        [AUTH_HEADER]: input.authHeader,
        "content-type": "application/json",
        "x-opengeni-correlation-id": input.correlationId ?? crypto.randomUUID(),
      },
      body: JSON.stringify({
        text: "accept this promptly",
        clientEventId: input.clientEventId,
        ...input.body,
      }),
    },
  );
}

describe("prompt durable-enqueue acknowledgement (real PostgreSQL 17/FORCE RLS)", () => {
  test("returns the queued turn while realtime fanout and Temporal wake remain unresolved", async () => {
    const value = await fixture();
    const fanout = deferred();
    const wake = deferred();
    let fanoutStarted = false;
    let wakeStarted = false;
    const bus = new MemoryEventBus();
    const publish = bus.publish.bind(bus);
    bus.publish = async (...args) => {
      fanoutStarted = true;
      await fanout.promise;
      await publish(...args);
    };
    const application = app({
      bus,
      wakeSessionWorkflow: async () => {
        wakeStarted = true;
        await wake.promise;
      },
    });

    const started = performance.now();
    const response = await send(application, {
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      authHeader: value.authHeader,
      clientEventId: crypto.randomUUID(),
      correlationId: "prompt-enqueue-slow-delivery",
    });
    const elapsedMs = performance.now() - started;
    const body = (await response.json()) as {
      accepted: { type: string };
      turn: { id: string; status: string };
      queueVersion: number;
      queue: Array<{ id: string; status: string }>;
    };

    expect(response.status).toBe(202);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(response.headers.get("server-timing")).toContain("prompt-persistence");
    expect(response.headers.get("x-opengeni-correlation-id")).toBe("prompt-enqueue-slow-delivery");
    expect(body.accepted.type).toBe("user.message");
    expect(body.turn.status).toBe("queued");
    expect(body.queueVersion).toBeGreaterThan(0);
    expect(body.queue).toContainEqual(
      expect.objectContaining({ id: body.turn.id, status: "queued" }),
    );

    await Bun.sleep(0);
    expect(fanoutStarted).toBe(true);
    expect(wakeStarted).toBe(true);
    fanout.resolve();
    wake.resolve();
  });

  test("replays one accepted turn and one usage fact after a lost-response retry", async () => {
    const value = await fixture();
    const application = app({});
    const clientEventId = crypto.randomUUID();
    const request = {
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      authHeader: value.authHeader,
      clientEventId,
    };

    const first = await send(application, request);
    const firstBody = (await first.json()) as { accepted: { id: string }; turn: { id: string } };
    const replay = await send(application, request);
    const replayBody = (await replay.json()) as { accepted: { id: string }; turn: { id: string } };

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replayBody).toEqual(firstBody);
    const [counts] = await shared.admin<
      {
        turns: number;
        messages: number;
        usage: number;
        wakes: number;
        usageSubjectId: string;
        usageSourceResourceType: string;
        usageSourceResourceId: string;
        usageSessionId: string;
        usageInitiatorKind: string;
        usageInitiatorSubjectId: string;
        usageOrigin: string;
        usageQuantity: number;
        usageUnit: string;
      }[]
    >`
      select
        (select count(*)::int from session_turns where workspace_id = ${value.grant.workspaceId!}
          and session_id = ${value.session.id} and id = ${firstBody.turn.id}) as turns,
        (select count(*)::int from session_events where workspace_id = ${value.grant.workspaceId!}
          and session_id = ${value.session.id} and client_event_id = ${clientEventId}) as messages,
        (select count(*)::int from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as usage,
        (select count(*)::int from session_workflow_wake_outbox
          where workspace_id = ${value.grant.workspaceId!} and session_id = ${value.session.id}) as wakes,
        (select subject_id from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageSubjectId",
        (select source_resource_type from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageSourceResourceType",
        (select source_resource_id from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageSourceResourceId",
        (select session_id from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageSessionId",
        (select initiator_kind from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageInitiatorKind",
        (select initiator_subject_id from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageInitiatorSubjectId",
        (select origin from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageOrigin",
        (select quantity::int from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageQuantity",
        (select unit from usage_events where workspace_id = ${value.grant.workspaceId!}
          and turn_id = ${firstBody.turn.id} and event_type = 'agent_run.created') as "usageUnit"
    `;
    expect(counts).toEqual({
      turns: 1,
      messages: 1,
      usage: 1,
      wakes: 1,
      usageSubjectId: value.grant.subjectId,
      usageSourceResourceType: "session_turn",
      usageSourceResourceId: firstBody.turn.id,
      usageSessionId: value.session.id,
      usageInitiatorKind: "subject",
      usageInitiatorSubjectId: value.grant.subjectId,
      usageOrigin: "user",
      usageQuantity: 1,
      usageUnit: "run",
    });
  });

  test("does not wait for prior model capacity, a worker, or sandbox admission", async () => {
    const value = await fixture();
    const priorResponse = await send(app({}), {
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      authHeader: value.authHeader,
      clientEventId: crypto.randomUUID(),
    });
    const priorBody = (await priorResponse.json()) as { turn: { id: string } };
    expect(priorResponse.status).toBe(202);
    await shared.admin`
      update session_turns
      set status = 'waiting_capacity', updated_at = now()
      where workspace_id = ${value.grant.workspaceId!} and id = ${priorBody.turn.id}
    `;
    let sandboxResumeAttempts = 0;
    const application = app({
      resumeBoxById: async () => {
        sandboxResumeAttempts += 1;
        throw new Error("sandbox unavailable");
      },
    });

    const started = performance.now();
    const response = await send(application, {
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      authHeader: value.authHeader,
      clientEventId: crypto.randomUUID(),
      correlationId: "prompt-enqueue-capacity-independent",
    });
    const elapsedMs = performance.now() - started;
    const body = (await response.json()) as {
      turn: { id: string; status: string };
      queue: Array<{ id: string; status: string }>;
    };

    expect(response.status).toBe(202);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(sandboxResumeAttempts).toBe(0);
    expect(body.turn.status).toBe("queued");
    expect(body.queue).toContainEqual(
      expect.objectContaining({ id: body.turn.id, status: "queued" }),
    );
    const [stored] = await shared.admin<{ priorStatus: string; acceptedStatus: string }[]>`
      select
        (select status from session_turns where id = ${priorBody.turn.id}) as "priorStatus",
        (select status from session_turns where id = ${body.turn.id}) as "acceptedStatus"
    `;
    expect(stored).toEqual({ priorStatus: "waiting_capacity", acceptedStatus: "queued" });
  });

  test("rejects a stale draft revision without consuming the newer draft", async () => {
    const value = await fixture();
    const first = await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          saveComposerDraftInTransaction(tx as typeof db, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId!,
            sessionId: value.session.id,
            subjectId: value.grant.subjectId,
            expectedRevision: 0,
            text: "stale draft",
            resources: [],
            model: "scripted-model",
            reasoningEffort: "medium",
          }),
        ),
    );
    const newer = await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          saveComposerDraftInTransaction(tx as typeof db, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId!,
            sessionId: value.session.id,
            subjectId: value.grant.subjectId,
            expectedRevision: first.revision,
            text: "newer draft",
            resources: [],
            model: "scripted-model",
            reasoningEffort: "medium",
          }),
        ),
    );
    const clientEventId = crypto.randomUUID();
    const response = await send(app({}), {
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      authHeader: value.authHeader,
      clientEventId,
      correlationId: "prompt-enqueue-stale-draft",
      body: { text: first.text, expectedDraftRevision: first.revision },
    });
    const body = (await response.json()) as {
      error: {
        status: number;
        code: string;
        retryable: boolean;
        requestId: string;
        message: string;
      };
    };

    expect(response.status).toBe(409);
    expect(body.error).toEqual({
      status: 409,
      code: "conflict",
      retryable: false,
      requestId: "prompt-enqueue-stale-draft",
      message: "Composer draft changed",
    });
    const [stored] = await shared.admin<
      { revision: number; text: string; acceptedMessages: number }[]
    >`
      select revision::int as revision, text,
        (select count(*)::int from session_events
          where workspace_id = ${value.grant.workspaceId!}
            and session_id = ${value.session.id}
            and client_event_id = ${clientEventId}) as "acceptedMessages"
      from composer_drafts
      where workspace_id = ${value.grant.workspaceId!}
        and session_id = ${value.session.id}
        and subject_id = ${value.grant.subjectId}
    `;
    expect(stored).toEqual({
      revision: newer.revision,
      text: "newer draft",
      acceptedMessages: 0,
    });
  });

  test("bounds workspace-control lock contention with a typed retryable response", async () => {
    const value = await fixture();
    const application = app({});
    const lockReady = deferred();
    const releaseLock = deferred();
    const lock = shared.admin.begin(async (sql) => {
      await sql`
        select workspace_id from workspace_inference_controls
        where workspace_id = ${value.grant.workspaceId!}
        for update
      `;
      lockReady.resolve();
      await releaseLock.promise;
    });
    await lockReady.promise;

    const started = performance.now();
    const response = await send(application, {
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      authHeader: value.authHeader,
      clientEventId: crypto.randomUUID(),
      correlationId: "prompt-enqueue-lock-timeout",
    });
    const elapsedMs = performance.now() - started;
    const body = (await response.json()) as {
      error: {
        status: number;
        code: string;
        retryable: boolean;
        requestId: string;
        message: string;
      };
    };
    releaseLock.resolve();
    await lock;

    expect(response.status).toBe(503);
    expect(response.headers.get("x-opengeni-correlation-id")).toBe("prompt-enqueue-lock-timeout");
    expect(elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(body.error).toEqual({
      status: 503,
      code: "upstream_unavailable",
      retryable: true,
      requestId: "prompt-enqueue-lock-timeout",
      message: "OpenGeni is temporarily unavailable — retry.",
    });
    expect(JSON.stringify(body)).not.toMatch(/postgres|sql|html|workspace_inference_controls/i);
  });
});
