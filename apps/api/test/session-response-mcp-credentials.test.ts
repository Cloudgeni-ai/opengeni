import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  OPEN_SUFFIX_RUN_STATE_BLOB,
  signDelegatedAccessToken,
  type ClientSessionEvent,
  type Permission,
  type SessionAuthorizationPort,
  type SessionEvent,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptSessionApprovalDecision,
  acceptSessionHumanInputResponse,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionMcpServers,
  decryptVariableSetValue,
  encryptVariableSetValue,
  getSession,
  listSessionMcpServersForRun,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerSessionRoutes } from "../src/routes/sessions";

const delegationSecret = "response-mcp-test-delegation-secret";
const encryptionKey = new Uint8Array(32).fill(7);
const originalToken = "Bearer original-resume-fixture";
const refreshedToken = "Bearer refreshed-resume-fixture";
const permissions: Permission[] = ["sessions:read", "sessions:control", "mcp_servers:attach"];
const responseTypes = ["user.approvalDecision", "user.humanInputResponse"] as const;
type ResponseType = (typeof responseTypes)[number];
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-response-mcp-credentials");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(type: ResponseType, granted = permissions) {
  const suffix = crypto.randomUUID();
  const subjectId = `user:${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `response-mcp-account-${suffix}`,
    accountName: "Response MCP test",
    workspaceExternalSource: "test",
    workspaceExternalId: `response-mcp-workspace-${suffix}`,
    workspaceName: "Response MCP test",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    tools: [{ kind: "mcp", id: "crm" }],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await createSessionMcpServers(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    servers: [
      {
        id: "crm",
        name: "CRM",
        url: "https://crm.example.test/mcp",
        requireApproval: ["update_ticket"],
        headersEncrypted: {
          Authorization: encryptVariableSetValue(encryptionKey, originalToken),
          "X-Old": encryptVariableSetValue(encryptionKey, "removed-by-replacement"),
        },
      },
    ],
  });
  await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, subjectId, (db) =>
    submitHumanPromptInTransaction(db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      subjectId,
      actor: { type: "human", subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Wait for my response",
      resources: [],
      tools: [],
      reasoningEffortFallback: "low",
      source: "user",
    }),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture claim failed: ${claim.reason}`);
  const requestId = crypto.randomUUID();
  const questions = [
    {
      id: "environment",
      kind: "single_select" as const,
      prompt: "Which environment?",
      options: [{ id: "staging", label: "Staging" }],
      required: true,
      allowOther: false,
    },
  ];
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: claim.turn.id,
    triggerEventId: claim.turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: claim.turn.id,
    runState: {
      serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
      pendingApprovals: type === "user.approvalDecision" ? [{ id: "crm-call" }] : [],
      humanInputRequests:
        type === "user.humanInputResponse"
          ? [
              {
                id: requestId,
                toolCallId: "human-call",
                questions,
                allowSkip: true,
                expiresAt: null,
              },
            ]
          : [],
    },
    events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
  });
  const token = await signDelegatedAccessToken(delegationSecret, {
    accountId: grant.accountId,
    workspaceId,
    subjectId,
    permissions: granted,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const event: ClientSessionEvent =
    type === "user.approvalDecision"
      ? {
          type,
          clientEventId: crypto.randomUUID(),
          payload: { approvalId: "crm-call", decision: "approve", message: "Proceed" },
        }
      : {
          type,
          clientEventId: crypto.randomUUID(),
          payload: {
            requestId,
            response: {
              outcome: "answered",
              answers: [{ questionId: "environment", values: ["staging"] }],
            },
          },
        };
  return {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    subjectId,
    requestId,
    token,
    event,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function appFor(
  f: Fixture,
  options: { encryption?: boolean; port?: SessionAuthorizationPort } = {},
) {
  const bus = new MemoryEventBus();
  const signals: number[] = [];
  const noop = async () => undefined;
  const app = new Hono();
  app.onError((error) =>
    error instanceof HTTPException
      ? error.getResponse()
      : new Response("test failure", { status: 500 }),
  );
  registerSessionRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret,
      environmentsEncryptionKey:
        options.encryption === false ? "" : Buffer.from(encryptionKey).toString("base64"),
    }),
    db: client.db,
    bus,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalSessionControl: noop,
      signalApprovalDecision: async () => {
        // A separate connection sees the committed version before the resume signal.
        signals.push((await stored(f)).credential_version);
      },
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    getDocumentServices: () => ({}),
    sessionAuthorization: options.port,
  } as unknown as ApiRouteDeps);
  return { app, bus, signals };
}

function send(
  app: Hono,
  f: Fixture,
  updates: unknown = [{ id: "crm", headers: { Authorization: refreshedToken } }],
  event = f.event,
) {
  return app.request(`/v1/workspaces/${f.workspaceId}/sessions/${f.sessionId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...event,
      payload: {
        ...event.payload,
        ...(updates === null ? {} : { mcpCredentialUpdates: updates }),
      },
    }),
  });
}

async function stored(f: Fixture) {
  const [server] = await shared.admin<
    {
      credential_version: number;
      headers_encrypted: Record<string, string>;
      url: string;
      require_approval: string[];
    }[]
  >`
    select credential_version, headers_encrypted, url, require_approval from session_mcp_servers
    where session_id = ${f.sessionId} and server_id = 'crm'`;
  return server!;
}

async function responseEvents(f: Fixture) {
  return await shared.admin`select payload from session_events
    where session_id = ${f.sessionId} and type = ${f.event.type}`;
}

describe.each(responseTypes)("%s credential refresh (real PostgreSQL)", (type) => {
  test("commits encrypted replacement before signaling and preparing the resumed same turn", async () => {
    const f = await fixture(type);
    const { app, bus, signals } = appFor(f);
    const response = await send(app, f);
    expect(response.status).toBe(202);
    const event = (await response.json()) as SessionEvent;
    expect(event.payload).toEqual(f.event.payload);
    expect(signals).toEqual([2]);
    const server = await stored(f);
    expect(server).toMatchObject({
      credential_version: 2,
      url: "https://crm.example.test/mcp",
      require_approval: ["update_ticket"],
    });
    expect(Object.keys(server.headers_encrypted)).toEqual(["Authorization"]);
    expect(server.headers_encrypted.Authorization).not.toBe(refreshedToken);
    expect(decryptVariableSetValue(encryptionKey, server.headers_encrypted.Authorization!)).toBe(
      refreshedToken,
    );
    const metadata = await getSession(client.db, f.workspaceId, f.sessionId);
    expect(metadata?.mcpServers[0]).toMatchObject({
      id: "crm",
      headerNames: ["Authorization"],
      credentialVersion: 2,
    });
    const audit = JSON.stringify({
      event,
      storedEvents: await responseEvents(f),
      published: bus.published,
      metadata,
    });
    expect(audit).not.toContain(refreshedToken);
    expect(audit).not.toContain(originalToken);
    expect(audit).not.toContain("headersEncrypted");
    expect(audit).not.toContain("mcpCredentialUpdates");
    const resumedAttemptId = crypto.randomUUID();
    const resumed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      sessionId: f.sessionId,
      workflowId: `session-${f.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: resumedAttemptId,
      trigger: { kind: "approval", triggerEventId: event.id },
    });
    expect(resumed.action).toBe("claimed");
    if (resumed.action !== "claimed") throw new Error(`resume failed: ${resumed.reason}`);
    expect(resumed.turn.id).toBe(f.turnId);
    const servers = await listSessionMcpServersForRun(
      client.db,
      f.workspaceId,
      f.sessionId,
      resumedAttemptId,
      encryptionKey,
    );
    expect(servers[0]?.headers).toEqual({ Authorization: refreshedToken });
    expect(servers[0]?.requireApproval).toEqual(["update_ticket"]);
  });

  test("requires attach permission only when replacements are supplied", async () => {
    const f = await fixture(type, ["sessions:read", "sessions:control"]);
    const { app, bus, signals } = appFor(f);
    const denied = await send(app, f);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(refreshedToken);
    expect((await stored(f)).credential_version).toBe(1);
    expect(await responseEvents(f)).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
    expect(signals).toHaveLength(0);
    expect((await send(app, f, [])).status).toBe(202);
    expect((await stored(f)).credential_version).toBe(1);
  });

  test("keeps legacy responses without updates valid without attach permission", async () => {
    const f = await fixture(type, ["sessions:read", "sessions:control"]);
    const { app, signals } = appFor(f);
    expect((await send(app, f, null)).status).toBe(202);
    expect((await stored(f)).credential_version).toBe(1);
    expect(signals).toEqual([1]);
  });

  test("rejects unknown/duplicate servers and invalid header maps without partial updates", async () => {
    const f = await fixture(type);
    const { app, bus, signals } = appFor(f);
    for (const updates of [
      [
        { id: "crm", headers: { Authorization: refreshedToken } },
        { id: "missing", headers: {} },
      ],
      [
        { id: "crm", headers: {} },
        { id: "crm", headers: {} },
      ],
      [{ id: "crm", headers: { Authorization: refreshedToken, authorization: "duplicate" } }],
      [{ id: "crm", headers: { Authorization: `${refreshedToken}\r\nInjected: value` } }],
      [{ id: "crm", headers: { Authorization: "" } }],
    ]) {
      const response = await send(app, f, updates);
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain(refreshedToken);
      expect((await stored(f)).credential_version).toBe(1);
    }
    expect(await responseEvents(f)).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  test("fails closed without encryption or host response authorization", async () => {
    const f = await fixture(type);
    const unencrypted = appFor(f, { encryption: false });
    expect((await send(unencrypted.app, f)).status).toBe(503);
    const denied = appFor(f, {
      port: {
        authorizeSession: async ({ operation }) =>
          operation ===
          (type === "user.approvalDecision"
            ? "session.approval.write"
            : "session.human_input.write")
            ? { allowed: false, reason: "forbidden" }
            : { allowed: true },
      },
    });
    // The existing host authorization boundary conceals denied sessions as 404.
    expect((await send(denied.app, f)).status).toBe(404);
    expect((await stored(f)).credential_version).toBe(1);
    expect(await responseEvents(f)).toHaveLength(0);
    expect(unencrypted.signals).toHaveLength(0);
    expect(denied.signals).toHaveLength(0);
  });

  test("does not rotate for a stale wait or an invalid response", async () => {
    const f = await fixture(type);
    const { app, bus, signals } = appFor(f);
    const stale: ClientSessionEvent =
      f.event.type === "user.approvalDecision"
        ? { ...f.event, payload: { ...f.event.payload, approvalId: "stale-call" } }
        : { ...f.event, payload: { ...f.event.payload, requestId: crypto.randomUUID() } };
    expect((await send(app, f, [], stale)).status).toBe(
      type === "user.approvalDecision" ? 409 : 404,
    );
    // Repeat with credentials: a valid update may not commit for a stale reply.
    expect(
      (await send(app, f, [{ id: "crm", headers: { Authorization: refreshedToken } }], stale))
        .status,
    ).toBe(type === "user.approvalDecision" ? 409 : 404);
    if (f.event.type === "user.humanInputResponse") {
      const invalid: ClientSessionEvent = {
        ...f.event,
        payload: {
          ...f.event.payload,
          response: {
            outcome: "answered",
            answers: [{ questionId: "environment", values: ["not-an-option"] }],
          },
        },
      };
      expect(
        (await send(app, f, [{ id: "crm", headers: { Authorization: refreshedToken } }], invalid))
          .status,
      ).toBe(422);
    }
    expect((await stored(f)).credential_version).toBe(1);
    expect(await responseEvents(f)).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  test("accepts replacement on Reject or permitted Skip", async () => {
    const f = await fixture(type);
    const { app, signals } = appFor(f);
    const event: ClientSessionEvent =
      f.event.type === "user.approvalDecision"
        ? { ...f.event, payload: { ...f.event.payload, decision: "reject" } }
        : { ...f.event, payload: { ...f.event.payload, response: { outcome: "skipped" } } };
    expect(
      (await send(app, f, [{ id: "crm", headers: { Authorization: refreshedToken } }], event))
        .status,
    ).toBe(202);
    expect(signals).toEqual([2]);
    // A completed response replay must not apply fresh credentials from a later hook.
    expect(
      (
        await send(
          app,
          f,
          [{ id: "crm", headers: { Authorization: "Bearer retry-hook-token" } }],
          event,
        )
      ).status,
    ).toBe(type === "user.approvalDecision" ? 202 : 200);
    const server = await stored(f);
    expect(server.credential_version).toBe(2);
    expect(decryptVariableSetValue(encryptionKey, server.headers_encrypted.Authorization!)).toBe(
      refreshedToken,
    );
  });

  test("replays the response without rotating twice or publishing another event", async () => {
    const f = await fixture(type);
    const { app, bus } = appFor(f);
    const first = await send(app, f);
    const event = (await first.json()) as SessionEvent;
    const replay = await send(app, f, [
      { id: "crm", headers: { Authorization: "Bearer retry-hook-token" } },
    ]);
    expect(replay.status).toBe(type === "user.approvalDecision" ? 202 : 200);
    expect(((await replay.json()) as SessionEvent).id).toBe(event.id);
    const server = await stored(f);
    expect(server.credential_version).toBe(2);
    expect(decryptVariableSetValue(encryptionKey, server.headers_encrypted.Authorization!)).toBe(
      refreshedToken,
    );
    expect(await responseEvents(f)).toHaveLength(1);
    expect(bus.published.flat()).toHaveLength(1);
  });

  test("concurrent responders commit only the winning replacement", async () => {
    const f = await fixture(type);
    const { app } = appFor(f);
    const replies = await Promise.all([
      send(app, f),
      send(app, f, [{ id: "crm", headers: { Authorization: "Bearer competing-hook-token" } }], {
        ...f.event,
        clientEventId: crypto.randomUUID(),
      }),
    ]);
    expect(replies.filter((reply) => reply.status === 202)).toHaveLength(1);
    expect(replies.map((reply) => reply.status).sort()).toEqual(
      type === "user.approvalDecision" ? [202, 409] : [200, 202],
    );
    const server = await stored(f);
    expect(server.credential_version).toBe(2);
    const winner = replies.findIndex((reply) => reply.status === 202);
    expect(decryptVariableSetValue(encryptionKey, server.headers_encrypted.Authorization!)).toBe(
      [refreshedToken, "Bearer competing-hook-token"][winner]!,
    );
    expect(await responseEvents(f)).toHaveLength(1);
  });

  test("rolls back replacements and response state if the event write fails", async () => {
    const f = await fixture(type);
    const { app, bus, signals } = appFor(f);
    // A transient test-only database trigger fails after the credential update.
    // This pins the transaction boundary rather than mocking its call order.
    await shared.admin
      .unsafe(`create function test_reject_response_mcp_event() returns trigger language plpgsql as $$
      begin
        if new.session_id = '${f.sessionId}'::uuid and new.type = '${type}' then
          raise exception 'synthetic response event failure';
        end if;
        return new;
      end $$`);
    await shared.admin.unsafe(
      "create trigger test_reject_response_mcp_event before insert on session_events for each row execute function test_reject_response_mcp_event()",
    );
    try {
      expect((await send(app, f)).status).toBe(500);
      const server = await stored(f);
      expect(server.credential_version).toBe(1);
      expect(decryptVariableSetValue(encryptionKey, server.headers_encrypted.Authorization!)).toBe(
        originalToken,
      );
      expect(await responseEvents(f)).toHaveLength(0);
      if (type === "user.humanInputResponse") {
        const [request] =
          await shared.admin`select status from session_human_input_requests where id = ${f.requestId}`;
        expect(request?.status).toBe("pending");
      }
      expect(bus.published).toHaveLength(0);
      expect(signals).toHaveLength(0);
    } finally {
      await shared.admin.unsafe("drop trigger test_reject_response_mcp_event on session_events");
      await shared.admin.unsafe("drop function test_reject_response_mcp_event()");
    }
    expect((await send(app, f)).status).toBe(202);
    expect((await stored(f)).credential_version).toBe(2);
  });

  test("rolls back all encrypted updates if a server disappears during acceptance", async () => {
    const f = await fixture(type);
    const input = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      clientEventId: f.event.clientEventId,
      mcpCredentialUpdates: [
        {
          id: "crm",
          headersEncrypted: {
            Authorization: encryptVariableSetValue(encryptionKey, refreshedToken),
          },
        },
        { id: "disappeared", headersEncrypted: {} },
      ],
    };
    const acceptance =
      f.event.type === "user.approvalDecision"
        ? acceptSessionApprovalDecision(client.db, {
            ...input,
            subjectId: f.subjectId,
            payload: f.event.payload,
          })
        : acceptSessionHumanInputResponse(client.db, {
            ...input,
            respondedBy: f.subjectId,
            requestId: f.requestId,
            response: f.event.payload.response,
          });
    await expect(acceptance).rejects.toThrow("Unknown session MCP server: disappeared");
    expect((await stored(f)).credential_version).toBe(1);
    expect(await responseEvents(f)).toHaveLength(0);
  });
});

test("approval storage never echoes write-only request fields from an internal caller", async () => {
  const f = await fixture("user.approvalDecision");
  const result = await acceptSessionApprovalDecision(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    subjectId: f.subjectId,
    payload: {
      ...f.event.payload,
      mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: refreshedToken } }],
    },
  });
  expect(result.action).toBe("accepted");
  if (result.action !== "accepted") throw new Error("fixture approval not accepted");
  expect(result.event.payload).toEqual(f.event.payload);
  expect(JSON.stringify(await responseEvents(f))).not.toContain(refreshedToken);
  expect((await stored(f)).credential_version).toBe(1);
});
