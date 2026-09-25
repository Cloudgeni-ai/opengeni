import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  codeSearchSessionInExperiment,
  type CodeSearchDeploymentPolicy,
} from "@opengeni/contracts/code-search";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  configureCodeSearchDeploymentPolicy,
  createDb,
  createSession,
  getSession,
  updateWorkspaceSettings,
} from "../src/index";

// Migration 0520: a session's code_search decision is frozen when it is
// created, so a later deployment or workspace change never adds the tool (and
// its instruction) to a running session and breaks its prompt cache.

const OFF: CodeSearchDeploymentPolicy = { available: false, workspaceDefault: "off" };
const DEFAULT_ON: CodeSearchDeploymentPolicy = { available: true, workspaceDefault: "on" };
const EXPERIMENT: CodeSearchDeploymentPolicy = { available: true, workspaceDefault: "split" };

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-code-search-frozen");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterEach(() => {
  configureCodeSearchDeploymentPolicy(OFF);
});

afterAll(async () => {
  configureCodeSearchDeploymentPolicy(OFF);
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Code search freeze",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Code search freeze",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function create(
  grant: Awaited<ReturnType<typeof workspace>>,
  options: { requestedSessionId?: string; parentSessionId?: string } = {},
) {
  return await createSession(client.db, {
    ...options,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
}

function sessionIdInArm(inArm: boolean): string {
  for (;;) {
    const id = crypto.randomUUID();
    if (codeSearchSessionInExperiment(id) === inArm) return id;
  }
}

async function storedDecision(sessionId: string): Promise<boolean | null> {
  const [row] = await shared.admin<{ code_search_enabled: boolean | null }[]>`
    SELECT code_search_enabled FROM sessions WHERE id = ${sessionId}
  `;
  return row?.code_search_enabled ?? null;
}

describe("code_search decision frozen at session create (0520)", () => {
  test("a process that never installed a policy freezes new sessions off", async () => {
    const grant = await workspace();
    const session = await create(grant);
    expect(session.codeSearchEnabled).toBe(false);
    expect(await storedDecision(session.id)).toBe(false);
  }, 60_000);

  test("a root session freezes the deployment and workspace decision it was created under", async () => {
    const grant = await workspace();
    configureCodeSearchDeploymentPolicy(EXPERIMENT);
    const inArm = await create(grant, { requestedSessionId: sessionIdInArm(true) });
    const outOfArm = await create(grant, { requestedSessionId: sessionIdInArm(false) });
    expect(inArm.codeSearchEnabled).toBe(true);
    expect(outOfArm.codeSearchEnabled).toBe(false);

    await updateWorkspaceSettings(client.db, grant.workspaceId!, { codeSearchEnabled: true });
    expect(
      (await create(grant, { requestedSessionId: sessionIdInArm(false) })).codeSearchEnabled,
    ).toBe(true);
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { codeSearchEnabled: false });
    configureCodeSearchDeploymentPolicy(DEFAULT_ON);
    expect((await create(grant)).codeSearchEnabled).toBe(false);
  }, 60_000);

  test("later changes never move an existing session", async () => {
    const grant = await workspace();
    configureCodeSearchDeploymentPolicy(OFF);
    const before = await create(grant);
    configureCodeSearchDeploymentPolicy(DEFAULT_ON);
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { codeSearchEnabled: true });
    const reread = await getSession(client.db, grant.workspaceId!, before.id);
    expect(reread?.codeSearchEnabled).toBe(false);
    expect(await storedDecision(before.id)).toBe(false);
  }, 60_000);

  test("a child keeps its parent's decision, whatever the policy is now", async () => {
    const grant = await workspace();
    configureCodeSearchDeploymentPolicy(DEFAULT_ON);
    const onParent = await create(grant);
    configureCodeSearchDeploymentPolicy(OFF);
    const offParent = await create(grant);
    expect(onParent.codeSearchEnabled).toBe(true);
    expect(offParent.codeSearchEnabled).toBe(false);

    configureCodeSearchDeploymentPolicy(EXPERIMENT);
    const onChild = await create(grant, {
      requestedSessionId: sessionIdInArm(false),
      parentSessionId: onParent.id,
    });
    const offChild = await create(grant, {
      requestedSessionId: sessionIdInArm(true),
      parentSessionId: offParent.id,
    });
    expect(onChild.codeSearchEnabled).toBe(true);
    expect(offChild.codeSearchEnabled).toBe(false);
  }, 60_000);

  test("a session from before the column existed reads as off, and so do its children", async () => {
    const grant = await workspace();
    configureCodeSearchDeploymentPolicy(DEFAULT_ON);
    const legacy = await create(grant);
    await shared.admin`UPDATE sessions SET code_search_enabled = NULL WHERE id = ${legacy.id}`;
    expect((await getSession(client.db, grant.workspaceId!, legacy.id))?.codeSearchEnabled).toBe(
      false,
    );
    const child = await create(grant, { parentSessionId: legacy.id });
    expect(child.codeSearchEnabled).toBe(false);
  }, 60_000);
});
