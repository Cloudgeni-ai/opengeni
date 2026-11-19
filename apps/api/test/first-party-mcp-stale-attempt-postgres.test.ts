import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  signDelegatedAccessToken,
} from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import * as db from "@opengeni/db";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../src/app";

// An agent attempt's MCP request checks that the attempt is live and, in
// parallel, reads its frozen learning policy through the database's own
// attempt fence. When the turn moves on between those two reads (the attempt
// finishes or is superseded while the request is in flight), the liveness
// check has already passed and the database refuses the policy read instead.
// That refusal means the same thing as a stale attempt and must be answered
// like one, never as a server error.

const SECRET = "first-party-mcp-stale-attempt-secret";
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

type StaleRoute = { method: "POST" | "GET"; path: string };
// The first-party MCP routes, and a REST file route whose file-owner check
// reads the same learning policy before its handler runs.
const ROUTES: StaleRoute[] = [
  { method: "POST", path: "mcp" },
  { method: "POST", path: "mcp/docs" },
  { method: "GET", path: "mcp/docs" },
  { method: "POST", path: "mcp/files" },
  { method: "GET", path: "mcp/files" },
  { method: "GET", path: `files/${crypto.randomUUID()}` },
];

async function expectStaleAttemptRefusal(response: Response): Promise<void> {
  const body = (await response.json()) as { error?: Record<string, unknown> };
  expect({ status: response.status, details: body.error?.details }).toEqual({
    status: 403,
    details: { code: "agent_attempt_caller_stale" },
  });
  expect(body.error).toMatchObject({ code: "forbidden", retryable: false });
  expect(String(body.error?.message)).toContain("turn attempt that is no longer active");
}

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let pooled: ReturnType<typeof postgres>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("first-party-mcp-stale-attempt");
  if (!acquired) throw new Error("First-party MCP stale attempt tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  pooled = postgres(shared.appUrl, { max: 8, prepare: false });
  await pooled`select 1`;
}, 180_000);

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await pooled?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: SECRET,
    environmentsEncryptionKey: Buffer.alloc(32, 43).toString("base64"),
    sandboxBackend: "none",
  });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "mcp-stale-attempt",
    accountExternalId: `account-${suffix}`,
    accountName: "MCP stale attempt",
    workspaceExternalSource: "mcp-stale-attempt",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "MCP stale attempt",
    subjectId: `user:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    initialMessage: "stale attempt",
    resources: [],
    tools: [],
    metadata: {},
    model: settings.openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    firstPartyMcpPermissions: null,
    createdBy: { kind: "subject", subjectId: owner.subjectId, label: "Stale attempt" },
    createdByContext: {},
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("fixture session did not create an initial turn");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, owner.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture attempt was not claimed");
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    principalKind: "agent_attempt",
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  const app = createApp({
    settings,
    db: drizzle(pooled, { schema }) as unknown as Database,
    bus: new MemoryEventBus(),
    workflowClient: {} as SessionWorkflowClient,
    sessionAuthorization: null,
  });
  const request = (route: StaleRoute, credential = authorization) => {
    const post = route.method === "POST";
    return app.request(
      new Request(`http://127.0.0.1:8000/v1/workspaces/${owner.workspaceId}/${route.path}`, {
        method: route.method,
        headers: {
          accept: "application/json, text/event-stream",
          authorization: credential,
          ...(post ? { "content-type": "application/json" } : {}),
        },
        ...(post ? { body: JSON.stringify(listTools) } : {}),
      }),
    );
  };
  const staleCredential = async () =>
    `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      principalKind: "agent_attempt",
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId: crypto.randomUUID(),
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
  return { request, staleCredential, turnId: claimed.turn.id };
}

type AttemptProbe = { liveReads: number; staleReads: number; fenceRefusals: number };

/**
 * Count what the request's attempt checks saw, so a race test proves its 403
 * came from the database fence after a passing liveness check, not from a
 * liveness check that already read the changed turn.
 */
function probeAttemptChecks(): AttemptProbe {
  const probe: AttemptProbe = { liveReads: 0, staleReads: 0, fenceRefusals: 0 };
  const readFacts = db.getSessionAuthorizationFacts;
  spyOn(db, "getSessionAuthorizationFacts").mockImplementation(async (database, input) => {
    const facts = await readFacts(database, input);
    if (input.caller) {
      if (facts.caller?.turn) probe.liveReads += 1;
      else probe.staleReads += 1;
    }
    return facts;
  });
  const freeze = db.freezeAgentLearningPolicy;
  spyOn(db, "freezeAgentLearningPolicy").mockImplementation(async (database, context) => {
    try {
      return await freeze(database, context);
    } catch (error) {
      const message = db.nestedAuthorityRefusalMessage(error);
      if (message !== null && db.isAgentAttemptLivenessFence(message)) probe.fenceRefusals += 1;
      throw error;
    }
  });
  return probe;
}

/**
 * Wait until the request's liveness checks have read the turn as it was and
 * its database fence is queued behind our turn locks, with nothing else in
 * this database still running.
 */
async function untilFenceWaits(probe: AttemptProbe, liveReads: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<{ waiting: number; busy: number }[]>`
      select
        count(*) filter (where wait_event_type = 'Lock')::int as waiting,
        count(*) filter (
          where state = 'active' and wait_event_type is distinct from 'Lock'
        )::int as busy
      from pg_stat_activity
      where datname = current_database()
        and backend_type = 'client backend'
        and pid <> pg_backend_pid()
    `;
    if (row && row.waiting >= 1 && row.busy === 0 && probe.liveReads >= liveReads) return;
    await Bun.sleep(10);
  }
  throw new Error("the request's attempt fence never waited on the turn");
}

/**
 * Send the request while the turn's next execution generation is being
 * written (a recovery or a finish), committing it only once the request's
 * liveness checks have passed against the earlier state.
 */
async function requestWhileTurnMovesOn(
  send: () => Promise<Response>,
  turnId: string,
  liveReads: number,
): Promise<Response> {
  const probe = probeAttemptChecks();
  const writer = await shared.admin.reserve();
  let response: Response;
  try {
    await writer`begin`;
    // Session before turn, the order turn writers lock them in.
    await writer`
      select 1 from sessions
      where id = (select session_id from session_turns where id = ${turnId})
      for update
    `;
    await writer`select 1 from session_turns where id = ${turnId} for update`;
    const pending = send();
    await untilFenceWaits(probe, liveReads);
    await writer`
      update session_turns
      set execution_generation = execution_generation + 1
      where id = ${turnId}
    `;
    await writer`commit`;
    response = await pending;
  } finally {
    writer.release();
  }
  // The liveness checks passed and the database fence refused.
  expect(probe.staleReads).toBe(0);
  expect(probe.liveReads).toBeGreaterThanOrEqual(liveReads);
  expect(probe.fenceRefusals).toBeGreaterThanOrEqual(1);
  return response;
}

function routeLabel(route: StaleRoute): string {
  return route.path.startsWith("files/") ? "/files/:fileId" : `/${route.path}`;
}

describe("agent requests from an attempt that goes stale in flight", () => {
  for (const route of ROUTES) {
    test(`${route.method} ${routeLabel(route)} answers a stale attempt with 403, never 500`, async () => {
      const { request, turnId } = await fixture();
      await expectStaleAttemptRefusal(
        await requestWhileTurnMovesOn(() => request(route), turnId, 1),
      );
    }, 60_000);
  }
});

describe("a file route whose own file-owner check sees the attempt go stale", () => {
  test("GET /files/:fileId answers with 403, never 500", async () => {
    const { request, turnId } = await fixture();
    const route: StaleRoute = { method: "GET", path: `files/${crypto.randomUUID()}` };
    // A first request leaves the attempt's learning policy remembered, so the
    // next one's request context does not read it again. Only the file
    // route's own owner check reads it, after its own liveness check (the
    // request context's check and the route's: two live reads).
    const warm = await request(route);
    expect(warm.status).toBe(404);
    await expectStaleAttemptRefusal(await requestWhileTurnMovesOn(() => request(route), turnId, 2));
  }, 60_000);
});

// Guards: these already answered 403 before this change (the liveness check
// refuses the attempt up front); they keep the new mappings from changing it.
describe("guard: agent requests from an attempt that is already stale", () => {
  for (const route of ROUTES) {
    test(`${route.method} ${routeLabel(route)} answers with 403, never 500`, async () => {
      const { request, staleCredential } = await fixture();
      await expectStaleAttemptRefusal(await request(route, await staleCredential()));
    }, 60_000);
  }
});
