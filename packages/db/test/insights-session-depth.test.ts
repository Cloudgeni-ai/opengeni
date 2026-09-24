import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import { aggregateSessionDepth, bootstrapWorkspace, createDb, createSession } from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("insights-session-depth");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Insights depth",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Insights depth",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function makeSession(
  grant: Awaited<ReturnType<typeof fixture>>,
  parentSessionId: string | null = null,
) {
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    ...(parentSessionId ? { parentSessionId } : {}),
  });
}

describe("aggregateSessionDepth", () => {
  test("derives every summary figure from one grouped pass over the workspace", async () => {
    const grant = await fixture();
    const workspaceId = grant.workspaceId!;

    expect(await aggregateSessionDepth(client.db, workspaceId)).toEqual({
      buckets: [],
      sessionsTouched: 0,
      rootSessions: 0,
      deepestDepth: 0,
      deepestSessionId: null,
      deepestSessionTitle: "",
      avgDepth: 0,
      goalsActive: 0,
      goalsCompleted: 0,
    });

    const rootA = await makeSession(grant);
    await makeSession(grant);
    const child = await makeSession(grant, rootA.id);
    const grandchild = await makeSession(grant, child.id);

    const summary = await aggregateSessionDepth(client.db, workspaceId);
    expect(summary.buckets).toEqual([
      { depth: 0, sessions: 2 },
      { depth: 1, sessions: 1 },
      { depth: 2, sessions: 1 },
    ]);
    expect(summary.sessionsTouched).toBe(4);
    expect(summary.rootSessions).toBe(2);
    expect(summary.deepestDepth).toBe(2);
    expect(summary.deepestSessionId).toBe(grandchild.id);
    expect(summary.avgDepth).toBeCloseTo(0.75, 10);
    expect(summary.goalsActive).toBe(0);
    expect(summary.goalsCompleted).toBe(0);
  });
});
