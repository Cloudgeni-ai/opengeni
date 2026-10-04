import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  dispatchWithSessionAuthorizationReadReuse,
  requireLiveAgentAttemptAuthorization,
  SessionAuthorizationDeniedError,
  withSessionAuthorizationReadReuse,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-authorization-read-reuse");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** A live agent attempt, plus a way to make it stale behind the reader's back. */
async function liveAttempt(): Promise<{ grant: AccessGrant; supersede(): Promise<void> }> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "read-reuse-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Read reuse",
    workspaceExternalSource: "read-reuse-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Read reuse",
    subjectId: `user:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    initialMessage: "read reuse",
    resources: [],
    tools: [],
    metadata: {},
    model: testSettings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: owner.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, owner.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  return {
    grant: {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: ["sessions:read"],
      principalKind: "agent_attempt",
      metadata: {
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      },
    },
    supersede: async () => {
      await shared!.admin`UPDATE sessions SET active_turn_id = NULL WHERE id = ${session.id}`;
    },
  };
}

const check = (grant: AccessGrant) =>
  requireLiveAgentAttemptAuthorization(client.db, grant, grant.metadata!.sessionId as string);

test("only back-to-back checks share reads; later re-checks read fresh", async () => {
  if (!shared) return;

  // Route checks share the first read, so a change between them is not seen.
  const route = await liveAttempt();
  await withSessionAuthorizationReadReuse(async () => {
    await check(route.grant);
    await route.supersede();
    await check(route.grant);
  });
  // The reuse never outlives the request.
  await expect(check(route.grant)).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);

  // After hand-off, a check outside a tool dispatch reads fresh.
  const handOff = await liveAttempt();
  await withSessionAuthorizationReadReuse(async (reuse) => {
    await check(handOff.grant);
    reuse.handOffToToolDispatch();
    await handOff.supersede();
    await expect(check(handOff.grant)).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);
  });

  // A tool's entry check reuses the route's reads; its re-check after an
  // await, and any later dispatch, read fresh.
  const dispatch = await liveAttempt();
  await withSessionAuthorizationReadReuse(async (reuse) => {
    await check(dispatch.grant);
    reuse.handOffToToolDispatch();
    await dispatch.supersede();
    await dispatchWithSessionAuthorizationReadReuse(async () => {
      await check(dispatch.grant);
      await expect(check(dispatch.grant)).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);
    });
    await dispatchWithSessionAuthorizationReadReuse(async () => {
      await expect(check(dispatch.grant)).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);
    });
  });
}, 60_000);
