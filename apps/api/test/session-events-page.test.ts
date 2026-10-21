import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES,
  SESSION_EVENT_STEP_TYPES,
  sessionEventPayloadTruncation,
  signDelegatedAccessToken,
} from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";
import { registerSessionRoutes } from "../src/routes/sessions";

const SECRET = "session-events-page-test-secret";
const explicitDatabaseUrl = process.env.OPENGENI_SESSION_EVENTS_TEST_DATABASE_URL;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let app: Hono;

beforeAll(async () => {
  if (explicitDatabaseUrl) {
    admin = postgres(explicitDatabaseUrl, { max: 2 });
    client = createDb(explicitDatabaseUrl, { max: 2 });
  } else {
    shared = await acquireSharedTestDatabase("session-events-page");
    if (!shared) {
      if (requireRealDatabase) {
        throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
      }
      available = false;
      return;
    }
    admin = shared.admin;
    client = createDb(shared.appUrl, { max: 2 });
  }

  const noop = async () => undefined;
  app = new Hono();
  registerSessionRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
    }),
    db: client.db,
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
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (explicitDatabaseUrl) await admin?.end();
  await shared?.release();
}, 60_000);

async function fixture(): Promise<{
  workspaceId: string;
  sessionId: string;
  authorization: string;
}> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `event-page-account-${suffix}`,
    accountName: "Session event page account",
    workspaceExternalSource: "test",
    workspaceExternalId: `event-page-workspace-${suffix}`,
    workspaceName: "Session event page workspace",
    subjectId: `event-page-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "bounded event page fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  return {
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    authorization,
  };
}

describe("conversation-first event reads", () => {
  test("announce the conversation filter and keep the bookkeeping each page's turns draw", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<Array<{ accountId: string }>>`
      select account_id as "accountId" from sessions where id = ${sessionId}`;
    const [tools, plain, failed] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const rows: Array<[number, string, Record<string, unknown>, string | null]> = [
      [1, "user.message", { text: "question" }, null],
      [2, "turn.started", {}, tools],
      [3, "agent.model.request", { phase: "started" }, tools],
      [4, "agent.model.request", { phase: "headers" }, tools],
      [5, "agent.model.request", { phase: "first_byte" }, tools],
      [6, "agent.model.request", { phase: "completed" }, tools],
      [7, "agent.model.usage", { inputTokens: 10 }, tools],
      [8, "agent.toolCall.created", { id: "c1", name: "exec_command", arguments: {} }, tools],
      [9, "agent.toolCall.output", { id: "c1", output: "ok" }, tools],
      [10, "agent.model.request", { phase: "started" }, tools],
      [11, "agent.model.request", { phase: "first_byte" }, tools],
      [12, "agent.model.request", { phase: "completed" }, tools],
      [13, "agent.model.usage", { inputTokens: 10 }, tools],
      [14, "agent.message.completed", { text: "answer" }, tools],
      [15, "turn.completed", {}, tools],
      [16, "user.message", { text: "thanks" }, null],
      [17, "turn.started", {}, plain],
      [18, "agent.model.request", { phase: "started" }, plain],
      [19, "agent.model.request", { phase: "first_byte" }, plain],
      [20, "agent.model.request", { phase: "completed" }, plain],
      [21, "agent.model.usage", { inputTokens: 10 }, plain],
      [22, "agent.message.completed", { text: "welcome" }, plain],
      [23, "turn.completed", {}, plain],
      [24, "user.message", { text: "again" }, null],
      [25, "turn.started", {}, failed],
      [26, "agent.model.request", { phase: "started" }, failed],
      [27, "agent.model.request", { phase: "timed_out" }, failed],
      [28, "turn.failed", {}, failed],
    ];
    for (const [sequence, type, payload, turnId] of rows) {
      await admin`
        insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
        values (${session!.accountId}, ${workspaceId}, ${sessionId}, ${turnId}, ${sequence}, ${type},
          ${admin.json(payload as never)})`;
    }
    const read = async (query: string) => {
      const response = await app.request(
        `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?compact=1&payloadMode=full&${query}`,
        { headers: { authorization } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<{ sequence: number }>;
      return {
        sequences: body.map((event) => event.sequence),
        announced: response.headers.get("X-OpenGeni-Conversation-Filter"),
        hasMore: response.headers.get("X-OpenGeni-Has-More"),
      };
    };
    const conversation = `excludeTypes=${SESSION_EVENT_STEP_TYPES.join(",")}&presentedToolCalls=include`;

    expect(await read(`${conversation}&before=1000&limit=100`)).toEqual({
      sequences: [1, 2, 3, 4, 5, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28],
      announced: "2",
      hasMore: "false",
    });
    // Paging back: each page adds only rows within what it covers.
    const newest = await read(`${conversation}&before=1000&limit=4`);
    expect(newest).toEqual({
      sequences: [23, 24, 25, 26, 27, 28],
      announced: "2",
      hasMore: "true",
    });
    const middle = await read(`${conversation}&before=23&limit=4`);
    expect(middle.sequences).toEqual([15, 16, 17, 18, 19, 20, 21, 22]);
    const oldest = await read(`${conversation}&before=15&limit=4`);
    expect(oldest).toEqual({ sequences: [1, 2, 3, 4, 5, 14], announced: "2", hasMore: "false" });
    // Forward pages stop at their last row too.
    const forward = await read(`${conversation}&after=0&direction=after&limit=3`);
    expect(forward.sequences).toEqual([1, 2, 3, 4, 5, 14]);
    // Any page size, either direction: the pages add up to the unpaged read,
    // also when a page ends at a turn's start and the next holds none of its
    // rows' anchors.
    const unpaged = [1, 2, 3, 4, 5, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];
    for (let limit = 1; limit <= 6; limit += 1) {
      const forwardPages: number[] = [];
      for (let after = 0, pages = 0; pages < 40; pages += 1) {
        const page = await read(`${conversation}&after=${after}&direction=after&limit=${limit}`);
        forwardPages.push(...page.sequences);
        if (page.hasMore !== "true" || page.sequences.length === 0) break;
        after = page.sequences.at(-1)!;
      }
      expect({ limit, sequences: forwardPages }).toEqual({ limit, sequences: unpaged });
      const backwardPages: number[] = [];
      for (let before = 1000, pages = 0; pages < 40; pages += 1) {
        const page = await read(`${conversation}&before=${before}&limit=${limit}`);
        backwardPages.unshift(...page.sequences);
        if (page.hasMore !== "true" || page.sequences.length === 0) break;
        before = page.sequences[0]!;
      }
      expect({ limit, sequences: backwardPages }).toEqual({ limit, sequences: unpaged });
    }

    // An older reader's fallback keeps tool calls and bookkeeping; the
    // announcement tells it the server applies presentedToolCalls.
    const compat = await read(
      `excludeTypes=${SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES.join(",")}&presentedToolCalls=include&before=1000&limit=100`,
    );
    expect(compat.announced).toBe("2");
    expect(compat.sequences).toEqual(
      rows.map(([sequence]) => sequence).filter((sequence) => sequence !== 9),
    );
    // Other readers see no announcement and no added rows.
    const plainRead = await read(
      `excludeTypes=${SESSION_EVENT_STEP_TYPES.join(",")}&before=1000&limit=100`,
    );
    expect(plainRead.announced).toBeNull();
    expect(plainRead.sequences).toEqual([1, 2, 14, 15, 16, 17, 22, 23, 24, 25, 28]);
  });

  test("a read past a running turn's start keeps its startup rows with no other row in range", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<Array<{ accountId: string }>>`
      select account_id as "accountId" from sessions where id = ${sessionId}`;
    const turn = crypto.randomUUID();
    const rows: Array<[number, string, Record<string, unknown>, string | null]> = [
      [1, "user.message", { text: "question" }, null],
      [2, "turn.started", {}, turn],
      [3, "agent.model.request", { phase: "started" }, turn],
      [4, "agent.model.request", { phase: "first_byte" }, turn],
      [5, "agent.toolCall.created", { id: "c1", name: "exec_command", arguments: {} }, turn],
      [6, "agent.model.request", { phase: "started" }, turn],
      [7, "agent.model.usage", { inputTokens: 10 }, turn],
    ];
    for (const [sequence, type, payload, turnId] of rows) {
      await admin`
        insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
        values (${session!.accountId}, ${workspaceId}, ${sessionId}, ${turnId}, ${sequence}, ${type},
          ${admin.json(payload as never)})`;
    }
    const conversation = `excludeTypes=${SESSION_EVENT_STEP_TYPES.join(",")}&presentedToolCalls=include`;
    const read = async (query: string) => {
      const response = await app.request(
        `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?compact=1&payloadMode=full&${conversation}&${query}`,
        { headers: { authorization } },
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as Array<{ sequence: number }>).map(
        (event) => event.sequence,
      );
    };
    expect(await read("before=1000&limit=100")).toEqual([1, 2, 3, 4]);
    // Catching up from the turn start (or later) finds only bookkeeping rows.
    expect(await read("after=2&direction=after&limit=100")).toEqual([3, 4]);
    expect(await read("after=3&direction=after&limit=100")).toEqual([4]);
    expect(await read("after=4&direction=after&limit=100")).toEqual([]);
    expect(await read("after=2&before=4&limit=100")).toEqual([3]);
  });
});

describe("session event byte-bounded HTTP pages", () => {
  test("no-cursor monitoring returns a semantic tail instead of the oldest 40 deltas", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<Array<{ accountId: string }>>`
      select account_id as "accountId" from sessions where id = ${sessionId}`;
    await admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload, turn_generation
      )
      select ${session!.accountId}, ${workspaceId}, ${sessionId}, sequence,
        'agent.message.delta', ${admin.json({ text: "raw-token-fragment" })}, 1
      from generate_series(1, 40) as sequence`;
    await admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload, turn_generation
      ) values
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 41, 'session.context.compacted',
          ${admin.json({ status: "completed", checkpoint: "current" })}, 1),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 42, 'turn.completed',
          ${admin.json({ status: "completed", result: "authoritative" })}, 2)`;

    const monitoring = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`,
      { headers: { authorization } },
    );
    expect(monitoring.status).toBe(200);
    const body = (await monitoring.json()) as Array<{
      sequence: number;
      type: string;
      turnGeneration: number | null;
    }>;
    expect(body.map((event) => [event.sequence, event.type])).toEqual([
      [41, "session.context.compacted"],
      [42, "turn.completed"],
    ]);
    expect(body.some((event) => event.type === "agent.message.delta")).toBeFalse();
    expect(monitoring.headers.get("X-OpenGeni-Event-Mode")).toBe("monitoring");
    expect(monitoring.headers.get("X-OpenGeni-Event-Direction")).toBe("before");
    expect(monitoring.headers.get("X-OpenGeni-Payload-Mode")).toBe("summary");
    expect(monitoring.headers.get("X-OpenGeni-Covered-First")).toBe("41");
    expect(monitoring.headers.get("X-OpenGeni-Covered-Last")).toBe("42");
    expect(monitoring.headers.get("X-OpenGeni-Next-Before")).toBe("41");

    const latestTerminal = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?latest=terminal`,
      { headers: { authorization } },
    );
    const latestBody = (await latestTerminal.json()) as typeof body;
    expect(latestBody).toHaveLength(1);
    expect(latestBody[0]).toMatchObject({
      sequence: 42,
      type: "turn.completed",
      turnGeneration: 2,
    });

    const compactLatest = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?latest=terminal&resultMode=compact&payloadMode=summary`,
      { headers: { authorization } },
    );
    expect(compactLatest.status).toBe(200);
    expect(await compactLatest.json()).toMatchObject({
      version: 1,
      status: "completed",
      sequence: 42,
      semanticClass: "terminal",
      result: "authoritative",
      coveredSequence: { first: 42, last: 42 },
    });
    expect(compactLatest.headers.get("X-OpenGeni-Event-Result-Mode")).toBe("compact");
    expect(compactLatest.headers.get("X-OpenGeni-Payload-Mode")).toBe("full");
    expect(compactLatest.headers.get("X-OpenGeni-Covered-First")).toBe("42");

    const forensic = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?mode=forensic&payloadMode=full&after=0&limit=40`,
      { headers: { authorization } },
    );
    const forensicBody = (await forensic.json()) as typeof body;
    expect(forensicBody).toHaveLength(40);
    expect(forensicBody.every((event) => event.type === "agent.message.delta")).toBeTrue();
    expect(forensic.headers.get("X-OpenGeni-Event-Direction")).toBe("after");
    expect(forensic.headers.get("X-OpenGeni-Next-After")).toBe("40");
    expect(forensic.headers.get("X-OpenGeni-Forensic-Exact")).toBe("true");
  });

  test("type/class filters and payload modes are explicit and validated", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<Array<{ accountId: string }>>`
      select account_id as "accountId" from sessions where id = ${sessionId}`;
    await admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload
      ) values
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 1, 'agent.model.usage',
          ${admin.json({ inputTokens: 10, outputTokens: 2 })}),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 2, 'machine.op.failed',
          ${admin.json({ code: "OFFLINE", detail: "x" })}),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 3, 'turn.completed',
          ${admin.json({ result: "requested-terminal" })}),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 4, 'machine.op.failed',
          ${admin.json({ code: "NEWER_FAILURE" })})`;

    const response = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?includeClasses=failure&payloadMode=none`,
      { headers: { authorization } },
    );
    const body = (await response.json()) as Array<{ type: string; payload: unknown }>;
    expect(body).toHaveLength(2);
    expect(body.at(-1)).toMatchObject({
      type: "machine.op.failed",
      payload: { _monitoring: { payloadMode: "none", payloadOmitted: true } },
    });

    const latest = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?latest=terminal`,
      { headers: { authorization } },
    );
    expect(latest.status).toBe(200);
    expect(await latest.json()).toEqual([
      expect.objectContaining({ sequence: 3, type: "turn.completed" }),
    ]);

    for (const incompatible of [
      "includeTypes=machine.op.failed",
      "excludeTypes=turn.completed",
      "includeClasses=failure",
      "excludeClasses=terminal",
    ]) {
      const rejected = await app.request(
        `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?latest=terminal&${incompatible}`,
        { headers: { authorization } },
      );
      expect(rejected.status).toBe(400);
    }

    const invalid = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?includeTypes=not.real`,
      { headers: { authorization } },
    );
    expect(invalid.status).toBe(400);

    const invalidResultMode = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?resultMode=compact`,
      { headers: { authorization } },
    );
    expect(invalidResultMode.status).toBe(400);
  });

  test("returns exact oversized payloads for both forensic and ordinary full reads", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<Array<{ accountId: string }>>`
      select account_id as "accountId" from sessions where id = ${sessionId}`;
    const callId = `forensic-${crypto.randomUUID()}`;
    const oversizedOutput = "界".repeat(Math.ceil((128 * 1024) / 3));
    const outputPayload = {
      id: callId,
      output: { id: `${callId}-oversized`, output: oversizedOutput },
    };
    await admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload
      ) values
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 1, 'agent.toolCall.created',
          ${admin.json({ id: callId, name: "exec_command", arguments: { cmd: "forensic-proof" } })}),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 2, 'agent.toolCall.output',
          ${admin.json(outputPayload)})`;

    const forensic = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?mode=forensic&payloadMode=full&after=0&limit=2`,
      { headers: { authorization } },
    );
    expect(forensic.status).toBe(200);
    const forensicBody = (await forensic.json()) as Array<{ type: string; payload: unknown }>;
    expect(forensicBody).toHaveLength(2);
    expect(forensicBody[1]).toEqual(
      expect.objectContaining({
        type: "agent.toolCall.output",
        payload: outputPayload,
      }),
    );
    expect(sessionEventPayloadTruncation(forensicBody[1]?.payload)).toBeNull();
    expect(forensic.headers.get("X-OpenGeni-Forensic-Exact")).toBe("true");

    const ordinaryFull = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?mode=monitoring&payloadMode=full&after=0&limit=2`,
      { headers: { authorization } },
    );
    expect(ordinaryFull.status).toBe(200);
    const ordinaryBody = (await ordinaryFull.json()) as Array<{ type: string; payload: unknown }>;
    expect(ordinaryBody).toHaveLength(2);
    expect(ordinaryBody[1]?.payload).toEqual(outputPayload);
    expect(sessionEventPayloadTruncation(ordinaryBody[1]?.payload)).toBeNull();
    expect(ordinaryFull.headers.get("X-OpenGeni-Forensic-Exact")).toBe("false");
  });

  test("step reads can ask for bounded tool-output previews", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<Array<{ accountId: string }>>`
      select account_id as "accountId" from sessions where id = ${sessionId}`;
    const output = `${"line of command output\n".repeat(3_000)}exit 0`;
    await admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload
      ) values
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 1, 'agent.toolCall.created',
          ${admin.json({ id: "call-1", name: "exec_command", arguments: { cmd: "seq" } })}),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 2, 'agent.toolCall.output',
          ${admin.json({ id: "call-1", output })})`;
    const base = `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`;
    const steps = "includeTypes=agent.toolCall.created,agent.toolCall.output&compact=1";

    const preview = await app.request(
      `${base}?${steps}&before=3&direction=before&limit=200&payloadMode=full&toolOutputs=preview`,
      { headers: { authorization } },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("X-OpenGeni-Tool-Outputs")).toBe("preview");
    expect(preview.headers.get("X-OpenGeni-Forensic-Exact")).toBe("false");
    const previewBody = (await preview.json()) as Array<{ payload: Record<string, unknown> }>;
    expect(previewBody).toHaveLength(2);
    const previewed = previewBody[1]!.payload;
    expect(previewed.id).toBe("call-1");
    expect(previewed.outputPreview).toEqual(
      expect.objectContaining({ truncated: true, shape: "structured" }),
    );
    expect(String(previewed.output).endsWith("exit 0")).toBe(true);
    expect(String(previewed.output).length).toBeLessThan(2_000);
    expect(Number(preview.headers.get("X-OpenGeni-Page-Bytes"))).toBeLessThan(4_000);

    // Summary pages and servers ignore the option; one row reads exactly.
    const summary = await app.request(
      `${base}?${steps}&after=0&limit=2&payloadMode=summary&toolOutputs=preview`,
      { headers: { authorization } },
    );
    expect(summary.headers.get("X-OpenGeni-Tool-Outputs")).toBeNull();
    const exact = await app.request(
      `${base}?includeTypes=agent.toolCall.output&after=1&before=3&direction=after&limit=1&payloadMode=full`,
      { headers: { authorization } },
    );
    const exactBody = (await exact.json()) as Array<{ payload: Record<string, unknown> }>;
    expect(exactBody).toHaveLength(1);
    expect(exactBody[0]!.payload).toEqual({ id: "call-1", output });
  });

  test("delivers an oversized chat message intact and resumes after its exact cursor", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<
      Array<{ accountId: string }>
    >`select account_id as "accountId" from sessions where id = ${sessionId}`;
    const text = `HEAD-${"p".repeat(3 * 1024 * 1024)}-TAIL`;
    await admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload
      ) values (
        ${session!.accountId}, ${workspaceId}, ${sessionId}, 1,
        'agent.message.completed',
        ${admin.json({
          id: "legacy-page-stranding-output",
          text,
        })}
      ), (
        ${session!.accountId}, ${workspaceId}, ${sessionId}, 2,
        'turn.completed', ${admin.json({ result: "after-projected-row" })}
      )`;

    const response = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?mode=forensic&payloadMode=full&after=0&limit=2&compact=true`,
      { headers: { authorization } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ sequence: number; payload: unknown }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.sequence).toBe(1);
    expect((body[0]!.payload as { text: string }).text).toBe(text);
    expect(sessionEventPayloadTruncation(body[0]?.payload)).toBeNull();
    expect(response.headers.get("X-OpenGeni-Forensic-Exact")).toBe("false");
    expect(response.headers.get("X-OpenGeni-Next-After")).toBe("1");
    expect(response.headers.get("X-OpenGeni-Has-More")).toBe("true");
    expect(Number(response.headers.get("X-OpenGeni-Page-Bytes"))).toBeGreaterThan(1024 * 1024);
    expect(response.headers.get("X-OpenGeni-Page-Max-Bytes")).toBe(
      response.headers.get("X-OpenGeni-Page-Bytes"),
    );
    const next = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?payloadMode=full&after=1&limit=2&compact=true`,
      { headers: { authorization } },
    );
    expect(next.status).toBe(200);
    const nextBody = (await next.json()) as Array<{ sequence: number }>;
    expect(nextBody.map((event) => event.sequence)).toEqual([2]);
    expect(next.headers.get("X-OpenGeni-Has-More")).toBe("false");
  });

  test("compact pages expose exact bytes and advance through coalescedUntil", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<
      Array<{ accountId: string }>
    >`select account_id as "accountId" from sessions where id = ${sessionId}`;
    for (let sequence = 1; sequence <= 50; sequence += 1) {
      await admin`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload
        ) values (
          ${session!.accountId}, ${workspaceId}, ${sessionId}, ${sequence},
          'agent.message.delta', ${admin.json({ text: `delta-${sequence};` })}
        )`;
    }

    const first = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?mode=forensic&payloadMode=full&after=9&limit=40&compact=true`,
      { headers: { authorization } },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Array<{
      sequence: number;
      payload: { text: string; coalescedUntil: number };
    }>;
    expect(firstBody).toHaveLength(1);
    expect(firstBody[0]).toMatchObject({
      sequence: 10,
      payload: { coalescedUntil: 49 },
    });
    expect(firstBody[0]!.payload.text).toStartWith("delta-10;");
    expect(firstBody[0]!.payload.text).toEndWith("delta-49;");
    expect(first.headers.get("X-OpenGeni-Page-Bytes")).toBe(
      String(Buffer.byteLength(JSON.stringify(firstBody), "utf8")),
    );
    expect(first.headers.get("X-OpenGeni-Page-Truncated")).toBe("true");
    expect(first.headers.get("X-OpenGeni-Next-After")).toBe("49");
    expect(first.headers.get("X-OpenGeni-Covered-Last")).toBe("49");
    expect(first.headers.get("X-OpenGeni-Forensic-Exact")).toBe("false");

    const second = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?after=49&limit=40&compact=true`,
      { headers: { authorization } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Array<{
      sequence: number;
      payload: { coalescedUntil: number };
    }>;
    expect(secondBody).toHaveLength(1);
    expect(secondBody[0]).toMatchObject({
      sequence: 50,
      payload: { coalescedUntil: 50 },
    });
    expect(second.headers.get("X-OpenGeni-Page-Truncated")).toBe("false");
    expect(second.headers.get("X-OpenGeni-Next-After")).toBe("50");
  });

  test("a near-limit event always yields a nonempty advancing page", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<
      Array<{ accountId: string }>
    >`select account_id as "accountId" from sessions where id = ${sessionId}`;
    await admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload
      ) values (
        ${session!.accountId}, ${workspaceId}, ${sessionId}, 1,
        'agent.tool_call.completed',
        ${admin.json({ id: "large", output: `HEAD-${"界🙂".repeat(5_000)}-TAIL` })}
      )`;

    const response = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?after=0&limit=1`,
      { headers: { authorization } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ sequence: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.sequence).toBe(1);
    expect(response.headers.get("X-OpenGeni-Next-After")).toBe("1");
    expect(Number(response.headers.get("X-OpenGeni-Page-Bytes"))).toBe(
      Buffer.byteLength(JSON.stringify(body), "utf8"),
    );
  });
});
