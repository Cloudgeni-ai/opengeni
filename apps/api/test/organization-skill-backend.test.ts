import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { sha256Hex } from "@opengeni/contracts/values";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  initializeSessionStartAtomically,
  listSkillDescriptors,
  saveAgentLearningSettings,
  type DbClient,
} from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { Hono } from "hono";
import { registerPreferenceRegistryRoutes } from "../src/routes/preference-registry";
import { registerSkillContentRoutes } from "../src/routes/skill-content";

const secret = "organization-skill-backend-test-delegation";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const db = await acquireSharedTestDatabase("organization-skill-backend");
  if (!db) throw new Error("PostgreSQL required");
  shared = db;
  client = createDb(db.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function setup() {
  const uid = crypto.randomUUID();
  const subjectId = `user:test-${uid}`;
  const { accountId, workspaceId } = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: uid,
      accountName: "Example organization",
      workspaceExternalSource: "test",
      workspaceExternalId: uid,
      workspaceName: "First tenant",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const allowed = (await createWorkspace(client.db, { accountId, name: "Second tenant" })).id;
  const personal = (await createWorkspace(client.db, { accountId, name: "Personal" })).id;
  await shared.admin`insert into organization_memberships (account_id,subject_id,status,personal_workspace_id)
    values (${accountId},${`user:personal-${uid}`},'active',${personal})`;
  const mint = async (permissions: Permission[], selected = false) => {
    const token = `ogk_${crypto.randomUUID()}${crypto.randomUUID()}`;
    const apiKey = await createOrganizationApiKey(client.db, {
      accountId,
      name: `Backend ${crypto.randomUUID()}`,
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions,
      policy: {
        preset: "custom",
        permissions,
        workspaceScope: selected
          ? { kind: "selected", workspaceIds: [workspaceId] }
          : { kind: "all" },
      },
    });
    return { authorization: `Bearer ${token}`, subjectId: `api_key:${apiKey.id}` };
  };
  const agent = async (targetWorkspaceId = workspaceId) => {
    const session = await createSession(client.db, {
      accountId,
      workspaceId: targetWorkspaceId,
      initialMessage: "Use tenant Skills",
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    });
    await initializeSessionStartAtomically(client.db, {
      accountId,
      workspaceId: targetWorkspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, targetWorkspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("Test attempt was not claimed");
    const bearer = await signDelegatedAccessToken(secret, {
      accountId,
      workspaceId: targetWorkspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: ["workspace:read", "sessions:read"],
      principalKind: "agent_attempt",
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    return `Bearer ${bearer}`;
  };
  const app = new Hono();
  const deps = {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
  } as ApiRouteDeps;
  registerSkillContentRoutes(app, deps);
  registerPreferenceRegistryRoutes(app, deps);
  const request = (
    path: string,
    authorization: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    workspace = workspaceId,
  ) =>
    app.request(`/v1/workspaces/${workspace}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { accountId, workspaceId, subjectId, allowed, personal, mint, agent, request };
}

function folder() {
  return {
    operationId: crypto.randomUUID(),
    skillId: crypto.randomUUID(),
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    stableKey: `tenant-procedure-${crypto.randomUUID()}`,
    reason: "Publish tenant procedure",
    files: [
      {
        path: "SKILL.md",
        content:
          "---\nname: tenant-procedure\ndescription: A tenant procedure.\n---\nDo the review.",
      },
    ],
  };
}

test("organization key bypasses Learning Off and records its own identity on save, edit and removal", async () => {
  const org = await setup();
  const key = await org.mint(["account:admin", "workspace:read"]);
  await saveAgentLearningSettings(
    client.db,
    {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: org.subjectId,
        settingsScopes: ["workspace"],
      },
    },
    {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "off", instructions: "off", skills: "off" },
    },
  );
  const original = folder();
  const save = (body: unknown) => org.request("/organization-skills/save", key.authorization, body);
  const saved = await save(original);
  expect(saved.status).toBe(200);
  const receipt = await saved.json();
  expect(receipt).toMatchObject({ outcome: "applied", replayed: false });
  expect(
    await listSkillDescriptors(client.db, { accountId: org.accountId, workspaceId: org.allowed }),
  ).toContainEqual(
    expect.objectContaining({ id: original.skillId, revisionId: receipt.revisionId }),
  );
  expect(
    await shared.admin`SELECT provenance_source, provenance_source_id FROM preference_registry_revisions
      WHERE id=${receipt.revisionId}`,
  ).toEqual([{ provenance_source: "organization_api_key", provenance_source_id: key.subjectId }]);
  expect(await (await save(original)).json()).toMatchObject({
    revisionId: receipt.revisionId,
    replayed: true,
  });
  const change = {
    ...original,
    operationId: crypto.randomUUID(),
    expectedRevisionId: receipt.revisionId,
  };
  expect(
    (
      await save({
        ...change,
        initialReach: { allowedWorkspaceIds: [], allowPersonalWorkspaces: false },
      })
    ).status,
  ).toBe(409);
  const changed = await save(change);
  expect(changed.status).toBe(200);
  const edited = await changed.json();
  expect(edited.revisionId).not.toBe(receipt.revisionId);
  const path = `/organization-skills/${original.skillId}/remove`;
  const remove = {
    operationId: crypto.randomUUID(),
    expectedRevisionId: edited.revisionId,
    expectedScopeVersion: 1,
    reason: "Retire tenant procedure",
  };
  expect(await (await org.request(path, key.authorization, remove)).json()).toMatchObject({
    outcome: "applied",
    removed: true,
    replayed: false,
  });
  expect(await (await org.request(path, key.authorization, remove)).json()).toMatchObject({
    removed: true,
    replayed: true,
  });
  const rows =
    await shared.admin`SELECT actor FROM skill_write_receipts WHERE account_id=${org.accountId}
    AND receipt->>'skillId'=${original.skillId}`;
  expect(rows.map((row) => row.actor)).toEqual(
    Array(3).fill({
      kind: "organization_api_key",
      principalKind: "api_key",
      subjectId: key.subjectId,
    }),
  );
  expect(
    await listSkillDescriptors(client.db, { accountId: org.accountId, workspaceId: org.allowed }),
  ).toHaveLength(0);
});

test("initial reach is atomic even while its write is blocked, and the legacy reader respects it", async () => {
  const org = await setup();
  const key = await org.mint(["account:admin", "workspace:read"]);
  const original = folder();
  const save = (body: unknown) => org.request("/organization-skills/save", key.authorization, body);
  const reach = { allowedWorkspaceIds: [org.allowed], allowPersonalWorkspaces: false };
  // Abort a create for an invalid Personal workspace before testing a concurrent valid create.
  expect(
    (await save({ ...original, initialReach: { ...reach, allowedWorkspaceIds: [org.personal] } }))
      .status,
  ).toBe(422);
  const visible = async () =>
    await Promise.all(
      [org.workspaceId, org.allowed, org.personal].map(async (workspaceId) =>
        (await listSkillDescriptors(client.db, { accountId: org.accountId, workspaceId })).some(
          (row) => row.id === original.skillId,
        ),
      ),
    );
  expect(await visible()).toEqual([false, false, false]);
  await shared.admin
    .unsafe(`CREATE FUNCTION pause_test_reach_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(22340, 1); RETURN NEW; END $$;
    CREATE TRIGGER pause_test_reach_insert BEFORE INSERT ON organization_skill_reach
    FOR EACH ROW EXECUTE FUNCTION pause_test_reach_insert()`);
  const pending: { save?: Promise<Response> } = {};
  try {
    await shared.admin.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(22340, 1)`;
      pending.save = Promise.resolve(save({ ...original, initialReach: reach }));
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [{ waiting }] = await tx`SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE locktype='advisory' AND classid=22340 AND objid=1 AND NOT granted) AS waiting`;
        if (waiting) break;
        if (Date.now() >= deadline) throw new Error("Skill save did not reach the blocked INSERT");
        await Bun.sleep(15);
      }
      expect(await visible()).toEqual([false, false, false]);
    });
    const result = await pending.save!;
    expect(result.status).toBe(200);
    expect((await result.json()).outcome).toBe("applied");
  } finally {
    await pending.save?.catch(() => undefined);
    await shared.admin.unsafe(
      "DROP TRIGGER pause_test_reach_insert ON organization_skill_reach; DROP FUNCTION pause_test_reach_insert()",
    );
  }
  expect(await visible()).toEqual([false, true, false]);

  // A real, accepted attempt in the excluded workspace must not receive a legacy handle either.
  const agent = await org.agent();
  const summary = await org.request("/preferences/summary", agent);
  expect(summary.status).toBe(200);
  expect((await summary.json()).descriptors).toEqual([]);
  const legacyList = await org.request("/preferences", agent);
  expect(legacyList.status).toBe(200);
  expect((await legacyList.json()).preferences).toEqual([]);
  expect((await org.request(`/preferences/${original.skillId}`, agent)).status).toBe(404);
  expect((await org.request(`/skills/content/${original.skillId}`, agent)).status).toBe(404);
  const allowedSummary = await org.request(
    "/preferences/summary",
    await org.agent(org.allowed),
    undefined,
    "GET",
    org.allowed,
  );
  expect(allowedSummary.status).toBe(200);
  expect((await allowedSummary.json()).descriptors).toContainEqual(
    expect.objectContaining({ id: original.skillId }),
  );
  const current = await org.request(
    `/organization-skills/${original.skillId}/reach`,
    key.authorization,
    {
      allowedWorkspaceIds: [],
      allowPersonalWorkspaces: true,
    },
    "PUT",
  );
  expect(current.status).toBe(200);
  expect(await visible()).toEqual([false, false, true]);
  expect(await (await save({ ...original, initialReach: reach })).json()).toMatchObject({
    replayed: true,
  });
  expect(await visible()).toEqual([false, false, true]);
}, 30_000);

test("signed workspace attempts and organization keys without organization-wide administration cannot write", async () => {
  const org = await setup();
  const original = folder();
  const agent = await org.agent();
  const nonAdmin = await org.mint(["workspace:read", "workspace:admin"]);
  const selected = await org.mint(["workspace:read", "account:admin"], true);
  const admin = await org.mint(["workspace:read", "account:admin"]);
  const saved = await org.request("/organization-skills/save", admin.authorization, original);
  expect(saved.status).toBe(200);
  const { revisionId } = await saved.json();
  const edit = { ...original, operationId: crypto.randomUUID(), expectedRevisionId: revisionId };
  const remove = {
    operationId: crypto.randomUUID(),
    expectedRevisionId: revisionId,
    expectedScopeVersion: 1,
    reason: "Retire tenant procedure",
  };
  for (const authorization of [agent, nonAdmin.authorization, selected.authorization]) {
    expect((await org.request("/organization-skills/save", authorization, folder())).status).toBe(
      403,
    );
    expect((await org.request("/organization-skills/save", authorization, edit)).status).toBe(403);
    expect(
      (await org.request(`/organization-skills/${original.skillId}/remove`, authorization, remove))
        .status,
    ).toBe(403);
  }
  expect(
    (await org.request("/skills/content/save", agent, { ...edit, scope: "organization" })).status,
  ).toBe(403);
  expect(
    (await org.request(`/skills/content/${original.skillId}/remove`, agent, remove)).status,
  ).toBe(403);
});
