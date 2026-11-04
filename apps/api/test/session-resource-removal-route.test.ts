import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  signDelegatedAccessToken,
  type FirstPartyMcpToolName,
  type ResourceRef,
  type Permission,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  settleSessionRepositoryCleanup,
  type DbClient,
} from "@opengeni/db";
import {
  pendingSessionRepositoryCleanup,
  withoutRemovedRepositories,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import type { Hono } from "hono";
import { createApp } from "../src/app";

// POST .../sessions/:id/resources/remove removes repositories from a session
// and its descendants; only a person or an API caller may do it.

const SECRET = "session-resource-removal-route-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-resource-removal");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

const ENVIRONMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
const settings = () =>
  testSettings({
    productAccessMode: "managed",
    delegationSecret: SECRET,
    environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
    sandboxBackend: "none",
  });

function app(): Hono {
  const noop = async () => undefined;
  return createApp({
    settings: settings(),
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
  } as Parameters<typeof createApp>[0]);
}

async function fixture(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-resource-removal-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session repositories",
    workspaceExternalSource: "session-resource-removal-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session repositories",
    subjectId: `user:${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function humanBearer(grant: Grant): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control", "sessions:create"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function sessionWith(
  grant: Grant,
  resources: ResourceRef[],
  parentSessionId: string | null = null,
) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "work on the repositories",
    resources,
    parentSessionId,
    tools: [],
    metadata: {},
    model: settings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: ["session_create"] as FirstPartyMcpToolName[],
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  return session;
}

async function agentBearer(grant: Grant, sessionId: string): Promise<string> {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  const permissions: Permission[] = [
    "sessions:read",
    "sessions:control",
    "sessions:create",
    "workspace:read",
  ];
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions,
    principalKind: "agent_attempt",
    sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    firstPartyMcpTools: ["session_create"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

const grocery: ResourceRef = {
  kind: "repository",
  uri: "https://git.example.test/acme/grocery-bot",
  ref: "main",
};
const docs: ResourceRef = {
  kind: "repository",
  uri: "https://git.example.test/acme/docs",
  ref: "main",
};

async function removeResources(
  target: Hono,
  bearer: string,
  grant: Grant,
  sessionId: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const response = await target.request(
    `/v1/workspaces/${grant.workspaceId}/sessions/${sessionId}/resources/remove`,
    {
      method: "POST",
      headers: { authorization: bearer, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, json: await response.json().catch(() => null) };
}

const uris = (resources: ResourceRef[] | undefined) =>
  (resources ?? []).filter((resource) => resource.kind === "repository").map((r) => r.uri);

async function removedEvents(grant: Grant, sessionId: string) {
  return (await listSessionEvents(client.db, grant.workspaceId, sessionId)).filter(
    (event) => event.type === "session.resources.removed",
  );
}

describe("removing repositories from a session (real PostgreSQL)", () => {
  test("a person removes a repository from the chat and every child chat", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const bearer = await humanBearer(grant);
    const root = await sessionWith(grant, [grocery, docs]);
    const child = await sessionWith(grant, [grocery, docs], root.id);
    const grandchild = await sessionWith(grant, [grocery], child.id);
    const docsChild = await sessionWith(grant, [docs], root.id);
    const unrelated = await sessionWith(grant, [grocery]);

    const removed = await removeResources(target, bearer, grant, root.id, {
      // Another spelling of the same repository.
      resources: [{ kind: "repository", uri: "https://git.example.test/Acme/grocery-bot.git" }],
    });
    expect(removed.status).toBe(200);
    expect(uris(removed.json.resources)).toEqual([docs.uri]);
    for (const [session, expected] of [
      [root, [docs.uri]],
      [child, [docs.uri]],
      [grandchild, []],
      [unrelated, [grocery.uri]],
    ] as const) {
      const stored = await getSession(client.db, grant.workspaceId, session.id);
      expect(uris(stored?.resources)).toEqual([...expected]);
    }
    const [rootEvent] = await removedEvents(grant, root.id);
    expect(rootEvent?.payload).toEqual({ resources: [grocery] });
    const [childEvent] = await removedEvents(grant, grandchild.id);
    expect(childEvent?.payload).toEqual({ resources: [grocery], removedFromSessionId: root.id });
    expect(await removedEvents(grant, unrelated.id)).toEqual([]);
    // Every descendant keeps a removal record; one that never had the
    // repository has nothing to clean up and records no event.
    const records = async (sessionId: string) =>
      ((await getSession(client.db, grant.workspaceId, sessionId))?.removedRepositories ?? []).map(
        (entry) => [entry.resource.uri, entry.sandboxCleanupPending],
      );
    expect(await records(root.id)).toEqual([[grocery.uri, true]]);
    expect(await records(grandchild.id)).toEqual([[grocery.uri, true]]);
    expect(await records(docsChild.id)).toEqual([[grocery.uri, false]]);
    expect(await removedEvents(grant, docsChild.id)).toEqual([]);
    expect(await records(unrelated.id)).toEqual([]);

    // A retry, or a repository that is not attached, changes nothing.
    const retry = await removeResources(target, bearer, grant, root.id, {
      resources: [{ kind: "repository", uri: grocery.uri }],
    });
    expect(retry.status).toBe(200);
    expect(await removedEvents(grant, root.id)).toHaveLength(1);

    for (const [body, status] of [
      [{ resources: [] }, 400],
      [{ resources: [{ kind: "file", fileId: crypto.randomUUID() }] }, 400],
      [{ resources: [{ kind: "repository", uri: "not a url" }] }, 422],
    ] as const) {
      const invalid = await removeResources(target, bearer, grant, root.id, body);
      expect(invalid.status).toBe(status);
    }
  });

  test("an agent cannot remove repositories or attach a removed one to a child", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const root = await sessionWith(grant, [grocery, docs]);
    const agent = await agentBearer(grant, root.id);

    const refused = await removeResources(target, agent, grant, root.id, {
      resources: [{ kind: "repository", uri: grocery.uri }],
    });
    expect(refused.status).toBe(403);
    expect(uris((await getSession(client.db, grant.workspaceId, root.id))?.resources)).toEqual([
      grocery.uri,
      docs.uri,
    ]);

    const person = await humanBearer(grant);
    expect(
      (
        await removeResources(target, person, grant, root.id, {
          resources: [{ kind: "repository", uri: grocery.uri }],
        })
      ).status,
    ).toBe(200);
    const createChild = async (bearer: string, resources: ResourceRef[]) =>
      await target.request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
        method: "POST",
        headers: { authorization: bearer, "content-type": "application/json" },
        body: JSON.stringify({ initialMessage: "child", resources }),
      });
    const followUp = async (bearer: string, sessionId: string) =>
      await target.request(`/v1/workspaces/${grant.workspaceId}/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { authorization: bearer, "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "use it again", resources: [grocery] },
        }),
      });
    const expectRefused = async (response: Response) => {
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("removed from this chat");
    };
    await expectRefused(await createChild(agent, [grocery]));
    await expectRefused(await followUp(agent, root.id));

    // The record outlasts the sandbox cleanup.
    const recorded = (await getSession(client.db, grant.workspaceId, root.id))!;
    await settleSessionRepositoryCleanup(
      client.db,
      grant.workspaceId,
      root.id,
      (recorded.removedRepositories ?? []).map((entry) => entry.id),
    );
    await expectRefused(await followUp(agent, root.id));

    // A child created after the removal inherits the record, so the agent
    // cannot attach the repository there or to a grandchild either.
    const created = await createChild(agent, [docs]);
    expect(created.status).toBe(202);
    const child = (await created.json()) as { id: string };
    const storedChild = (await getSession(client.db, grant.workspaceId, child.id))!;
    expect(uris(storedChild.resources)).toEqual([docs.uri]);
    expect(storedChild.removedRepositories?.map((entry) => entry.resource.uri)).toEqual([
      grocery.uri,
    ]);
    const childAgent = await agentBearer(grant, child.id);
    await expectRefused(await followUp(childAgent, child.id));
    await expectRefused(await createChild(childAgent, [grocery]));
  });

  test("a queued turn or goal continuation cannot restore a removed repository", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const root = await sessionWith(grant, [grocery, docs]);
    const person = await humanBearer(grant);
    await removeResources(target, person, grant, root.id, {
      resources: [{ kind: "repository", uri: grocery.uri }],
    });
    const stored = (await getSession(client.db, grant.workspaceId, root.id))!;
    const [record] = stored.removedRepositories ?? [];
    expect(record?.resource).toEqual(grocery);
    expect(record?.sandboxCleanupPending).toBe(true);
    expect(pendingSessionRepositoryCleanup(stored).map((entry) => entry.id)).toEqual([record!.id]);
    // The turn was accepted with both repositories attached.
    expect(uris(withoutRemovedRepositories([grocery, docs], stored))).toEqual([docs.uri]);

    // An attached repository always wins over a stale record.
    expect(
      uris(
        withoutRemovedRepositories([grocery, docs], {
          ...stored,
          resources: [...stored.resources, grocery],
        }),
      ),
    ).toEqual([grocery.uri, docs.uri]);

    // The sandbox cleanup settles exactly this removal; the record stays, so
    // later turns still leave the repository out.
    await settleSessionRepositoryCleanup(client.db, grant.workspaceId, root.id, [record!.id]);
    const cleaned = (await getSession(client.db, grant.workspaceId, root.id))!;
    expect(pendingSessionRepositoryCleanup(cleaned)).toEqual([]);
    expect(cleaned.removedRepositories?.map((entry) => entry.sandboxCleanupPending)).toEqual([
      false,
    ]);
    expect(uris(withoutRemovedRepositories([grocery, docs], cleaned))).toEqual([docs.uri]);

    // A person attaching the repository again with a message ends the record.
    const reattach = await target.request(
      `/v1/workspaces/${grant.workspaceId}/sessions/${root.id}/events`,
      {
        method: "POST",
        headers: { authorization: person, "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "use it again", resources: [grocery] },
        }),
      },
    );
    expect(reattach.status).toBeLessThan(300);
    const reattached = (await getSession(client.db, grant.workspaceId, root.id))!;
    expect(uris(reattached.resources).sort()).toEqual([docs.uri, grocery.uri].sort());
    expect(reattached.removedRepositories).toBeUndefined();
  });
});
