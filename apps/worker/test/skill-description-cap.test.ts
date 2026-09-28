import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AGENT_AUTHORED_SKILL_DESCRIPTION_MAX_CHARS,
  AGENT_AUTHORED_SKILL_DESCRIPTION_TOO_LONG_MESSAGE,
  type FsTreeNode,
} from "@opengeni/contracts";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { readSkill, saveSkill } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  saveAgentLearningSettings,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("skill-description-cap");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  app = createDb(shared.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

const skillMarkdown = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nFollow the steps.`;

const node = (path: string, type: FsTreeNode["type"], children?: FsTreeNode[]): FsTreeNode => ({
  path,
  name: path.split("/").at(-1)!,
  type,
  sizeBytes: null,
  mtimeMs: null,
  mode: null,
  truncated: false,
  ...(children ? { children } : {}),
});

/** A one-file sandbox directory for skill_publish. */
function directoryWith(skillMd: string) {
  return {
    fsList: async ({ path }: { path: string }) => ({
      root: node(path, "dir", [node(`${path}/SKILL.md`, "file")]),
      revision: 1,
      truncated: false,
    }),
    fsRead: async ({ path }: { path: string }) => {
      const bytes = Buffer.from(skillMd, "utf8");
      return {
        path,
        content: bytes.toString("base64"),
        sizeBytes: bytes.byteLength,
        encoding: "base64" as const,
        truncated: false,
        isBinary: false,
        revision: 1,
      };
    },
    fsWrite: async () => {
      throw new Error("skill_publish must not write");
    },
    fsMkdir: async () => {
      throw new Error("skill_publish must not create directories");
    },
  };
}

test("agent Skill writes cap new or changed descriptions and leave unchanged ones alone", async () => {
  if (!app || !shared) return;
  const db = app.db;
  const suffix = crypto.randomUUID();
  const subjectId = `user:skill-description-cap-${suffix}`;
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "skill-description-cap-test",
      accountExternalId: suffix,
      accountName: "Test",
      workspaceExternalSource: "skill-description-cap-test",
      workspaceExternalId: suffix,
      workspaceName: "Test",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const human = { kind: "human", subjectId, principalKind: "human_session" } as const;
  await saveAgentLearningSettings(
    db,
    { accountId, workspaceId, actor: { ...human, settingsScopes: ["workspace"] } },
    {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "automatic", instructions: "review_first", skills: "automatic" },
    },
  );

  const cap = AGENT_AUTHORED_SKILL_DESCRIPTION_MAX_CHARS;
  const longDescription = `Use when ${"x".repeat(cap)}`;
  expect(longDescription.length).toBeGreaterThan(cap);
  // A person may still store a long description; only agent writes are capped.
  const humanSkillId = crypto.randomUUID();
  const humanSaved = await saveSkill(db, {
    accountId,
    workspaceId,
    actor: human,
    operationId: crypto.randomUUID(),
    skillId: humanSkillId,
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    stableKey: `upstream-copy-${suffix}`,
    files: [
      { path: "SKILL.md", content: skillMarkdown("upstream-copy", longDescription) },
      { path: "references/notes.md", content: "old notes" },
    ],
    reason: "Fixture",
  });
  expect(humanSaved.outcome).toBe("applied");
  const humanHead = await readSkill(db, { accountId, workspaceId }, humanSkillId);

  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "Save this as a Skill",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: suffix,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Could not claim fixture turn");
  const scope = {
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
  let publishedSkillMd = "";
  const environment = createAttemptToolEnvironment({
    scope,
    generation: 1,
    definitions: createWorkspaceSkillTools({
      db,
      settings,
      accountId,
      workspaceId,
      actor: { kind: "agent", ...scope },
      selected: [],
      filesystem: async () => directoryWith(publishedSkillMd),
      modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
    }).filter((definition) => ["skill_save", "skill_publish"].includes(definition.modelName)),
  });
  const call = (modelName: string, args: Record<string, unknown>) =>
    environment.callModel({ modelName, arguments: args, subjectId: "agent:test" });
  const create = (skillId: string, description: string) =>
    call("skill_save", {
      operationId: crypto.randomUUID(),
      skillId,
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      files: [{ path: "SKILL.md", content: skillMarkdown("preview-ui-changes", description) }],
      reason: "User asked to remember a preference",
    });

  // A new Skill over the cap is refused with the actionable message, and
  // nothing is stored.
  const refusedId = crypto.randomUUID();
  await expect(create(refusedId, longDescription)).rejects.toThrow(
    AGENT_AUTHORED_SKILL_DESCRIPTION_TOO_LONG_MESSAGE,
  );
  expect(await readSkill(db, { accountId, workspaceId }, refusedId)).toBeNull();

  // Exactly at the cap is accepted.
  const acceptedId = crypto.randomUUID();
  const accepted = await create(acceptedId, "u".repeat(cap));
  expect(accepted.structuredContent).toMatchObject({ skillId: acceptedId, outcome: "applied" });

  // Editing a supporting file of a Skill whose stored description is already
  // long does not force a description rewrite.
  const supportingEdit = await call("skill_save", {
    operationId: crypto.randomUUID(),
    skillId: humanSkillId,
    expectedRevisionId: humanHead!.revisionId,
    expectedScopeVersion: humanHead!.scopeVersion,
    files: [{ path: "references/notes.md", content: "new notes" }],
    reason: "Update notes",
  });
  expect(supportingEdit.structuredContent).toMatchObject({ outcome: "applied" });
  const afterEdit = await readSkill(db, { accountId, workspaceId }, humanSkillId);
  expect(afterEdit?.description).toBe(longDescription);

  // Changing that description to another long one is agent-written and capped.
  await expect(
    call("skill_save", {
      operationId: crypto.randomUUID(),
      skillId: humanSkillId,
      expectedRevisionId: afterEdit!.revisionId,
      expectedScopeVersion: afterEdit!.scopeVersion,
      files: [
        {
          path: "SKILL.md",
          content: skillMarkdown("upstream-copy", `${longDescription} More detail.`),
        },
      ],
      reason: "Rewrite the description",
    }),
  ).rejects.toThrow(AGENT_AUTHORED_SKILL_DESCRIPTION_TOO_LONG_MESSAGE);
  expect((await readSkill(db, { accountId, workspaceId }, humanSkillId))?.revisionId).toBe(
    afterEdit!.revisionId,
  );

  // skill_publish goes through the same save path and the same cap.
  publishedSkillMd = skillMarkdown("published-skill", longDescription);
  const publishedId = crypto.randomUUID();
  await expect(
    call("skill_publish", {
      operationId: crypto.randomUUID(),
      skillId: publishedId,
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      directory: "checkout",
      reason: "Publish a new Skill",
    }),
  ).rejects.toThrow(AGENT_AUTHORED_SKILL_DESCRIPTION_TOO_LONG_MESSAGE);
  expect(await readSkill(db, { accountId, workspaceId }, publishedId)).toBeNull();
  publishedSkillMd = skillMarkdown("published-skill", "Use when publishing a release.");
  const published = await call("skill_publish", {
    operationId: crypto.randomUUID(),
    skillId: publishedId,
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    directory: "checkout",
    reason: "Publish a new Skill",
  });
  expect(published.structuredContent).toMatchObject({ skillId: publishedId, outcome: "applied" });
}, 180_000);
