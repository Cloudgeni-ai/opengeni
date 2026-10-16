import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  requireLiveAgentAttemptAuthorization,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  withSessionAuthorizationReadReuse,
} from "../src/session-authorization";

// Session authorization used to make five sequential scoped reads (Slack
// ownership, authority, caller session with its full projection, live attempt
// turn with its link and goal snapshot, target identity). It now reads every
// fact in one scoped statement: BEGIN, scope setup, the read, COMMIT.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let traced: ReturnType<typeof postgres>;
let db: Database;
const statements: string[] = [];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-authorization-round-trips");
  if (!acquired) throw new Error("Session authorization round trips require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  traced = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    debug: (_connection, query) => {
      statements.push(query.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase());
    },
  });
  db = drizzle(traced, { schema }) as unknown as Database;
  await traced`select 1`;
}, 180_000);

afterAll(async () => {
  await traced?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; count: number }> {
  statements.length = 0;
  const value = await fn();
  return { value, count: statements.length };
}

async function fixture() {
  const human = `user:authz-rtt:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "authz-rtt",
    accountExternalId: crypto.randomUUID(),
    accountName: "Authorization round trips",
    workspaceExternalSource: "authz-rtt",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Authorization round trips",
    subjectId: human,
  });
  const grant = access.workspaceGrants[0]!;
  const makeSession = async () =>
    await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Authorization fixture",
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: human },
    });
  const start = async (sessionId: string) => {
    await withWorkspaceSubjectSessionActivityRls(client.db, grant.workspaceId!, human, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId,
        subjectId: human,
        actor: { type: "human", subjectId: human },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Start a live attempt",
        resources: [],
        model: "scripted-model",
        reasoningEffort: "medium",
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`Fixture claim failed: ${claimed.reason}`);
    return { turnId: claimed.turn.id, generation: claimed.turn.executionGeneration, attemptId };
  };
  const caller = await makeSession();
  const live = await start(caller.id);
  const other = await makeSession();
  const humanGrant: AccessGrant = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: human,
    principalKind: "human_session",
    permissions: ["sessions:read", "sessions:control"],
  };
  const agentGrant = (
    overrides: Partial<{ turnId: string; attemptId: string; executionGeneration: number }> = {},
  ): AccessGrant => ({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: "agent:authz-rtt",
    principalKind: "agent_attempt",
    permissions: ["sessions:read", "sessions:control"],
    metadata: {
      sessionId: caller.id,
      turnId: live.turnId,
      attemptId: live.attemptId,
      executionGeneration: live.generation,
      ...overrides,
    },
  });
  return { grant, human, caller, live, other, humanGrant, agentGrant };
}

describe("session authorization round trips", () => {
  test("an agent attempt authorizes its own session in one scoped read", async () => {
    const scope = await fixture();
    const deps = { db, sessionAuthorization: undefined };
    const { value, count } = await counted(() =>
      requireSessionAuthorization(deps, scope.agentGrant(), {
        sessionId: scope.caller.id,
        operation: "session.control",
        surface: "http",
      }),
    );
    expect(value?.actor).toMatchObject({
      kind: "agent_attempt",
      callerSessionId: scope.caller.id,
      callerRootSessionId: scope.caller.id,
      turnId: scope.live.turnId,
      initiatingHumanSubjectId: scope.human,
    });
    expect(value?.target).toEqual({ sessionId: scope.caller.id, rootSessionId: scope.caller.id });
    expect(value?.relatedSessionAccess).toBe("root");
    // BEGIN, scope setup, the facts read, COMMIT.
    expect(count).toBe(4);
  });

  test("a human authorizes a shared session in one scoped read", async () => {
    const scope = await fixture();
    const { value, count } = await counted(() =>
      requireSessionAuthorization({ db, sessionAuthorization: undefined }, scope.humanGrant, {
        sessionId: scope.other.id,
        operation: "session.read",
        surface: "http",
      }),
    );
    expect(value).toBeNull();
    expect(count).toBe(4);
  });

  test("the route check and the live-attempt check share one read", async () => {
    const scope = await fixture();
    const deps = { db, sessionAuthorization: undefined };
    const { count } = await counted(() =>
      withSessionAuthorizationReadReuse(async () => {
        await requireSessionAuthorization(deps, scope.agentGrant(), {
          sessionId: scope.caller.id,
          operation: "session.control",
          surface: "http",
        });
        return await requireLiveAgentAttemptAuthorization(db, scope.agentGrant(), scope.caller.id);
      }),
    );
    expect(count).toBe(4);
  });

  test("stale, forged and mismatched attempts are still refused", async () => {
    const scope = await fixture();
    const deps = { db, sessionAuthorization: undefined };
    const denied = async (grant: AccessGrant, sessionId = scope.caller.id) => {
      const error = await requireSessionAuthorization(deps, grant, {
        sessionId,
        operation: "session.control",
        surface: "http",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionAuthorizationDeniedError);
      return (error as SessionAuthorizationDeniedError).reason;
    };
    expect(await denied(scope.agentGrant({ executionGeneration: scope.live.generation + 1 }))).toBe(
      "caller_stale",
    );
    expect(await denied(scope.agentGrant({ turnId: crypto.randomUUID() }))).toBe("caller_stale");
    expect(await denied(scope.agentGrant({ attemptId: crypto.randomUUID() }))).toBe("caller_stale");
    // A missing target is not found before the caller is even considered.
    expect(await denied(scope.agentGrant(), crypto.randomUUID())).toBe("not_found");

    // An attempt that is no longer live loses its authority.
    await shared.admin`
      update session_turn_attempts
      set state = 'closed', outcome = 'interrupted_recoverable', closed_at = now()
      where id = ${scope.live.attemptId}`;
    expect(await denied(scope.agentGrant())).toBe("caller_stale");
    await expect(
      requireLiveAgentAttemptAuthorization(db, scope.agentGrant(), scope.caller.id),
    ).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);
  });

  test("a Slack-private session stays with its owner and its own agents", async () => {
    const scope = await fixture();
    const deps = { db, sessionAuthorization: undefined };
    const slackOwned = await (async () => {
      const access = scope.grant;
      const session = await createSession(client.db, {
        accountId: access.accountId,
        workspaceId: access.workspaceId!,
        initialMessage: "Slack-owned",
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: scope.human },
      });
      const [connection] = await shared.admin<Array<{ id: string }>>`
        insert into connections (
          account_id, workspace_id, provider_domain, kind, status, credential_encrypted
        ) values (${access.accountId}, ${access.workspaceId!}, 'slack.com', 'app_install', 'active', 'sealed')
        returning id`;
      await shared.admin`
        insert into slack_interactions (
          account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
          slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id,
          visibility, session_reservation_id, session_id
        ) values (
          ${access.accountId}, ${access.workspaceId!}, ${connection!.id}, 'T1', 'D1', '1.1',
          ${`route-${crypto.randomUUID()}`}, ${`evt-${crypto.randomUUID()}`},
          'user:slack-owner', 'private', ${session.id}, ${session.id}
        )`;
      return session;
    })();
    const slackDenied = await requireSessionAuthorization(deps, scope.humanGrant, {
      sessionId: slackOwned.id,
      operation: "session.read",
      surface: "http",
    }).catch((caught: unknown) => caught);
    expect(slackDenied).toBeInstanceOf(SessionAuthorizationDeniedError);
    expect((slackDenied as SessionAuthorizationDeniedError).reason).toBe("forbidden");
    // An agent from another tree is refused too; the owner is not.
    const agentDenied = await requireSessionAuthorization(deps, scope.agentGrant(), {
      sessionId: slackOwned.id,
      operation: "session.read",
      surface: "http",
    }).catch((caught: unknown) => caught);
    expect((agentDenied as SessionAuthorizationDeniedError).reason).toBe("forbidden");
    const owner = await requireSessionAuthorization(
      deps,
      { ...scope.humanGrant, subjectId: "user:slack-owner" },
      { sessionId: slackOwned.id, operation: "session.read", surface: "http" },
    );
    expect(owner?.target).toEqual({ sessionId: slackOwned.id, rootSessionId: slackOwned.id });
  });
});
