import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
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
    sandboxBackend: "none",
  });
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  return {
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    authorization,
  };
}

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
  });

  test("compact pages expose exact bytes and advance through coalescedUntil", async () => {
    if (!available) return;
    const { workspaceId, sessionId, authorization } = await fixture();
    const [session] = await admin<
      Array<{ accountId: string }>
    >`select account_id as "accountId" from sessions where id = ${sessionId}`;
    for (let sequence = 10; sequence <= 50; sequence += 1) {
      await admin`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload
        ) values (
          ${session!.accountId}, ${workspaceId}, ${sessionId}, ${sequence},
          'agent.message.delta', ${admin.json({ text: `delta-${sequence};` })}
        )`;
    }

    const first = await app.request(
      `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?after=9&limit=40&compact=true`,
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
