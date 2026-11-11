import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  nestedPostgresSqlState,
} from "../src";
import {
  freezeAgentLearningPolicy,
  getAgentLearningSettings,
  getKnowledgeEntry,
  saveAgentLearningSettings,
  saveKnowledgeEntry,
  type KnowledgeContext,
} from "../src/knowledge-entries";

// Migration 1095: a Personal workspace learns like a shared one. Its chats that
// aren't Only me learn to its own Workspace layer, which only its owner can
// reach, and like a shared workspace's chats they never read the owner's
// Personal layer. These run as the restricted application role under FORCE
// RLS, and the settings seed runs as the NOSUPERUSER migration owner.

let db: RestrictedRuntimeTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  db = await acquireRestrictedRuntimeTestDatabase("personal-workspace-learning-scope");
  if (!db) throw new Error("Personal workspace learning verification requires PostgreSQL");
  client = createDb(db.appUrl, { max: 4, searchPath: db.schema });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await db?.release();
}, 180_000);

type HumanContext = KnowledgeContext & {
  actor: Extract<KnowledgeContext["actor"], { kind: "human" }>;
};

/** One organization: its owner's Personal workspace and a shared workspace. */
async function fixture() {
  const admin = db!.admin;
  const subjectId = `user:${crypto.randomUUID()}`;
  const accountId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID();
  const sharedWorkspaceId = crypto.randomUUID();
  await admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Personal learning')`;
  for (const [id, name] of [
    [personalWorkspaceId, "Personal"],
    [sharedWorkspaceId, "Team"],
  ] as const) {
    await admin`INSERT INTO workspaces(id,account_id,name) VALUES(${id},${accountId},${name})`;
    await admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${id},${accountId})`;
  }
  await admin`INSERT INTO organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    VALUES(${accountId},${subjectId},'owner','active',${personalWorkspaceId})`;
  await admin`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,role)
    VALUES(${accountId},${sharedWorkspaceId},${subjectId},'admin')`;
  const human = (workspaceId: string): HumanContext => ({
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  });
  return { accountId, subjectId, personalWorkspaceId, sharedWorkspaceId, human };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A running turn the owner started, in a workspace chat or an Only me (user-memory) one. */
async function attempt(f: Fixture, workspaceId: string, onlyMe = false) {
  const session = await createSession(client.db, {
    accountId: f.accountId,
    workspaceId,
    initialMessage: "Learn about Acme",
    resources: [],
    tools: [],
    metadata: {},
    ...(onlyMe ? { memoryScope: "user" as const, scopeSubjectId: f.subjectId } : {}),
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.subjectId },
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: f.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: started.temporalWorkflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Claim failed: ${claim.reason}`);
  const agent: KnowledgeContext = {
    accountId: f.accountId,
    workspaceId,
    actor: {
      kind: "agent",
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  return { session, agent };
}

function save(context: KnowledgeContext, title: string, scope?: "workspace" | "personal") {
  const entryId = crypto.randomUUID();
  return saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId,
    expectedVersion: 0,
    ...(scope ? { scope } : {}),
    entry: { kind: "fact", title, content: `${title}: renewal is in March.` },
  }).then((receipt) => ({ ...receipt, entryId }));
}

async function sqlState(action: Promise<unknown>) {
  return await action.then(
    () => null,
    (error: unknown) => nestedPostgresSqlState(error) ?? String(error),
  );
}

describe("a Personal workspace learns like a shared one", () => {
  test("the owner's workspace chat there saves to the workspace and, as in a shared workspace, reads no Personal Knowledge", async () => {
    const f = await fixture();
    const mine = await save(f.human(f.personalWorkspaceId), "My own note", "personal");

    const { agent } = await attempt(f, f.personalWorkspaceId);
    const policy = await freezeAgentLearningPolicy(client.db, agent);
    expect(policy).toMatchObject({ defaultScope: "workspace", subjectId: null });
    expect(Object.keys(policy)).not.toContain("personalReadSubjectId");
    const learned = await save(agent, "Learned in Personal");
    const stored = await getKnowledgeEntry(
      client.db,
      f.human(f.personalWorkspaceId),
      learned.entryId,
    );
    expect(stored).toMatchObject({ scope: "workspace" });
    expect(await getKnowledgeEntry(client.db, agent, learned.entryId)).toMatchObject({
      scope: "workspace",
    });
    expect(await getKnowledgeEntry(client.db, agent, mine.entryId)).toBeNull();
    // The owner still has their existing Personal entry.
    expect(
      await getKnowledgeEntry(client.db, f.human(f.personalWorkspaceId), mine.entryId),
    ).toMatchObject({ scope: "personal" });

    // The same person's workspace chat in a shared workspace behaves the same,
    // and never sees the Personal workspace's own Workspace Knowledge.
    const elsewhere = await attempt(f, f.sharedWorkspaceId);
    expect(await freezeAgentLearningPolicy(client.db, elsewhere.agent)).toMatchObject({
      defaultScope: "workspace",
      subjectId: null,
    });
    expect(await getKnowledgeEntry(client.db, elsewhere.agent, mine.entryId)).toBeNull();
    expect(await getKnowledgeEntry(client.db, elsewhere.agent, learned.entryId)).toBeNull();
    expect(
      await getKnowledgeEntry(client.db, f.human(f.sharedWorkspaceId), learned.entryId),
    ).toBeNull();
  }, 120_000);

  test("an Only me chat in a Personal workspace still learns for its person", async () => {
    const f = await fixture();
    const { agent } = await attempt(f, f.personalWorkspaceId, true);
    const policy = await freezeAgentLearningPolicy(client.db, agent);
    expect(policy).toMatchObject({ defaultScope: "personal", subjectId: f.subjectId });
    const learned = await save(agent, "Only me");
    expect(
      await getKnowledgeEntry(client.db, f.human(f.personalWorkspaceId), learned.entryId),
    ).toMatchObject({ scope: "personal" });
  }, 120_000);

  test("an Only me chat saving to the Personal workspace meets the workspace's mode", async () => {
    const f = await fixture();
    await saveAgentLearningSettings(client.db, f.human(f.personalWorkspaceId), {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "off", instructions: "automatic", skills: "automatic" },
    });
    const { agent } = await attempt(f, f.personalWorkspaceId, true);
    expect(await sqlState(save(agent, "Into the workspace", "workspace"))).toBe("42501");
    // Its own destination is still governed by its own mode.
    expect(await sqlState(save(agent, "For me"))).toBeNull();
  }, 120_000);
});

describe("migration 1095 keeps the owner's chosen modes", () => {
  /** The migration's seed for one organization, as the restricted migration owner. */
  async function runSeed(accountId: string) {
    const migration = readFileSync(
      new URL("../drizzle/1095_personal_workspace_learning_scope.sql", import.meta.url),
      "utf8",
    );
    const seed = migration.slice(migration.indexOf("DO $personal_workspace_learning_seed$"));
    const scoped = seed.replace(
      "WHERE m.personal_workspace_id IS NOT NULL",
      `WHERE m.personal_workspace_id IS NOT NULL AND m.account_id='${accountId}'`,
    );
    expect(scoped).not.toBe(seed);
    await db!.admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE "${db!.ownerRole}"`);
      await tx.unsafe(scoped);
    });
  }

  test("the Personal workspace's own layer takes the owner's Personal defaults and its chats' overrides, once", async () => {
    const f = await fixture();
    const human = f.human(f.personalWorkspaceId);
    await saveAgentLearningSettings(client.db, human, {
      scope: "personal",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "review_first", instructions: "automatic", skills: "off" },
    });
    // Before 1095 a workspace chat there used the owner's Personal layer.
    const { session } = await attempt(f, f.personalWorkspaceId);
    await db!
      .admin`INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,subject_id,
        context_key,version,settings,operation_id,request_hash,actor_subject_id)
      VALUES(${f.accountId},${f.personalWorkspaceId},${`personal:${f.subjectId}`},${f.subjectId},
        ${`chat:${session.id}`},1,'{"instructions":"off"}'::jsonb,${crypto.randomUUID()},'fixture',${f.subjectId})`;
    // An override from a shared workspace stays with the Personal layer only.
    const elsewhere = await attempt(f, f.sharedWorkspaceId);
    await db!
      .admin`INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,subject_id,
        context_key,version,settings,operation_id,request_hash,actor_subject_id)
      VALUES(${f.accountId},${f.sharedWorkspaceId},${`personal:${f.subjectId}`},${f.subjectId},
        ${`chat:${elsewhere.session.id}`},1,'{"knowledge":"off"}'::jsonb,${crypto.randomUUID()},'fixture',${f.subjectId})`;

    await runSeed(f.accountId);
    expect((await getAgentLearningSettings(client.db, human, "workspace")).settings).toEqual({
      knowledge: "review_first",
      instructions: "automatic",
      skills: "off",
    });
    expect(
      (
        await getAgentLearningSettings(client.db, human, "workspace", {
          kind: "chat",
          id: session.id,
        })
      ).settings,
    ).toEqual({ instructions: "off" });
    const copied = await db!.admin<Array<{ context_key: string }>>`
      SELECT context_key FROM agent_learning_revisions
      WHERE account_id=${f.accountId} AND owner_key=${`workspace:${f.personalWorkspaceId}`}
      ORDER BY context_key`;
    expect(copied.map((row) => row.context_key)).toEqual(["chat:" + session.id, "defaults"].sort());
    // The Personal layer itself is unchanged.
    expect((await getAgentLearningSettings(client.db, human, "personal")).settings).toEqual({
      knowledge: "review_first",
      instructions: "automatic",
      skills: "off",
    });

    // A layer that already has its own row is never overwritten, and a rerun adds nothing.
    await saveAgentLearningSettings(client.db, human, {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      settings: { knowledge: "automatic", instructions: "off", skills: "off" },
    });
    await runSeed(f.accountId);
    expect((await getAgentLearningSettings(client.db, human, "workspace")).settings).toEqual({
      knowledge: "automatic",
      instructions: "off",
      skills: "off",
    });
    const [count] = await db!.admin<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM agent_learning_revisions
      WHERE account_id=${f.accountId} AND owner_key=${`workspace:${f.personalWorkspaceId}`}`;
    expect(count?.count).toBe(3);
  }, 120_000);
});
