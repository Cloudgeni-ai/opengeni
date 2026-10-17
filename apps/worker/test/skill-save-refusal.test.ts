import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getAgentLearningSettings,
  initializeSessionStartAtomically,
  saveAgentLearningSettings,
  type KnowledgeContext,
} from "@opengeni/db";
import { readSkill, saveSkill } from "@opengeni/core";
import type { SkillScope } from "@opengeni/contracts";
import { LEARNING_REFUSAL_META_KEY } from "@opengeni/contracts/learning-refusal";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";

// A Skill change the lifecycle refuses rolls back as a whole. The agent must
// get a definite refusal with the reason, not a failed query that repeats
// every parameter (the Skill's text included) and leaves the outcome unknown.
// The refusal also carries a content-free `_meta` fact the model never sees,
// so the timeline can tell the person their change was not saved.
//
// A chat that learns for its person may still explicitly change the
// workspace's Skills, under the stricter of its own and the workspace's
// Skills mode.
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("skill-save-refusal");
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

type Mode = "automatic" | "review_first" | "off";
type SkillSaveResult = {
  isError: boolean;
  content: Array<{ text: string }>;
  structuredContent: {
    outcome?: string;
    error?: { code: string; message: string; retryable: boolean };
  };
  _meta?: Record<string, unknown>;
};

async function setSkillsMode(
  db: ReturnType<typeof createDb>["db"],
  human: KnowledgeContext,
  scope: "workspace" | "personal",
  skills: Mode,
) {
  const current = await getAgentLearningSettings(db, human, scope);
  await saveAgentLearningSettings(db, human, {
    scope,
    operationId: crypto.randomUUID(),
    expectedVersion: current.version,
    settings: { knowledge: "automatic", instructions: "review_first", skills },
  });
}

async function skillSaveFixture(
  db: ReturnType<typeof createDb>["db"],
  input: {
    skillScope: SkillScope;
    learning: "personal" | "workspace";
    modes?: { personal?: Mode; workspace?: Mode };
    /** Whether a verified person started the chat's turn (true by default). */
    person?: boolean;
  },
) {
  const suffix = crypto.randomUUID();
  const subjectId = `user:skill-save-refusal-${suffix}`;
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "skill-save-refusal-test",
      accountExternalId: suffix,
      accountName: "Test",
      workspaceExternalSource: "skill-save-refusal-test",
      workspaceExternalId: suffix,
      workspaceName: "Test",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const human: KnowledgeContext = {
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
  };
  // Settings saved before the chat's turn is accepted govern that turn.
  if (input.modes?.workspace) await setSkillsMode(db, human, "workspace", input.modes.workspace);
  if (input.modes?.personal) await setSkillsMode(db, human, "personal", input.modes.personal);
  const skillId = crypto.randomUUID();
  const privateText = `Private procedure ${suffix}.`;
  const saved = await saveSkill(db, {
    accountId,
    workspaceId,
    actor: { kind: "human", subjectId, principalKind: "human_session" },
    operationId: crypto.randomUUID(),
    skillId,
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    stableKey: `notes-${suffix}`,
    scope: input.skillScope,
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: notes\ndescription: Notes\n---\n${privateText}`,
      },
    ],
    reason: "Fixture",
  });

  const session = await createSession(db, {
    accountId,
    workspaceId,
    // A chat using personal memory saves what it learns only for its person,
    // like a private chat.
    ...(input.learning === "personal" ? { memoryScope: "user" as const } : {}),
    ...(input.learning === "personal" || input.person !== false
      ? { createdBy: { kind: "subject" as const, subjectId } }
      : {}),
    initialMessage: "Update the notes Skill",
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
  const actor = {
    kind: "agent" as const,
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
  const definitions = createWorkspaceSkillTools({
    db,
    settings,
    accountId,
    workspaceId,
    subjectId,
    actor,
    selected: [],
    filesystem: async () => {
      throw new Error("skill_save needs no sandbox");
    },
    modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
  });
  const skillSave = definitions.find((definition) => definition.modelName === "skill_save")!;
  const editNotes = async () =>
    (await skillSave.execute(
      {
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: saved.revisionId,
        expectedScopeVersion: 1,
        files: [{ path: "notes.md", content: "More notes" }],
        reason: "Add notes",
      },
      { operationId: crypto.randomUUID(), caller: { kind: "model" } } as never,
    )) as SkillSaveResult;
  const readNotes = () => readSkill(db, { accountId, workspaceId, subjectId }, skillId);
  return {
    accountId,
    workspaceId,
    subjectId,
    actor,
    skillSave,
    skillId,
    privateText,
    saved,
    editNotes,
    readNotes,
  };
}

describe("skill_save refusals", () => {
  test("a personal Skill edited from a shared chat with no person to save for is refused with its reason", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "user",
      learning: "workspace",
      person: false,
    });
    const result = await fixture.editNotes();

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe("skill_change_refused");
    expect(result.structuredContent.error?.retryable).toBe(false);
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("This chat isn't allowed to make this Skill change");
    // The agent is asked to tell the person, never discouraged from it.
    expect(text).toContain("Tell the person in your reply that it was not saved");
    expect(text).not.toMatch(/ask for (an )?approval/iu);
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain(fixture.privateText);
    // The person is told, in the timeline, that it was not saved and why.
    expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toEqual({
      destination: "skill",
      reason: "not_permitted",
      skillId: fixture.skillId,
    });
    // Nothing was saved.
    expect((await fixture.readNotes())?.revisionId).toBe(fixture.saved.revisionId);
  }, 120_000);

  test("a workspace Skill the workspace has Off for Skills is reported as not saved from a personal chat", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "personal",
      modes: { personal: "automatic", workspace: "off" },
    });
    const result = await fixture.editNotes();

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe("skill_change_refused");
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("Agent learning for Skills is Off");
    expect(text).toContain("Tell the person in your reply that it was not saved");
    expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toEqual({
      destination: "skill",
      reason: "learning_off",
      skillId: fixture.skillId,
    });
    expect((await fixture.readNotes())?.revisionId).toBe(fixture.saved.revisionId);
  }, 120_000);
});

describe("the person's own personal Skill from a shared chat", () => {
  test("publishes when the chat and the person are both Automatic", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "user",
      learning: "workspace",
      modes: { personal: "automatic", workspace: "automatic" },
    });
    const result = await fixture.editNotes();
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.structuredContent.outcome).toBe("applied");
    const after = await fixture.readNotes();
    expect(after?.scope).toBe("user");
    expect(after?.revisionId).not.toBe(fixture.saved.revisionId);
  }, 120_000);

  test("the person's own Review first leaves a pending proposal", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "user",
      learning: "workspace",
      modes: { personal: "review_first", workspace: "automatic" },
    });
    const result = await fixture.editNotes();
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.structuredContent.outcome).toBe("pending");
    expect((await fixture.readNotes())?.revisionId).toBe(fixture.saved.revisionId);
  }, 120_000);
});

describe("explicit workspace Skill destination from a chat that learns for its person", () => {
  test("editing an existing workspace Skill publishes when both modes are Automatic", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "personal",
      modes: { personal: "automatic", workspace: "automatic" },
    });
    const result = await fixture.editNotes();

    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.structuredContent.outcome).toBe("applied");
    expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toBeUndefined();
    const after = await fixture.readNotes();
    expect(after?.scope).toBe("workspace");
    expect(after?.revisionId).not.toBe(fixture.saved.revisionId);
    expect(after?.files.map((file) => file.path)).toContain("notes.md");
  }, 120_000);

  test("the workspace's Review first leaves a pending proposal even when the chat is Automatic", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "personal",
      modes: { personal: "automatic", workspace: "review_first" },
    });
    const result = await fixture.editNotes();

    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.structuredContent.outcome).toBe("pending");
    expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toBeUndefined();
    expect((await fixture.readNotes())?.revisionId).toBe(fixture.saved.revisionId);
  }, 120_000);

  test("the chat's own Review first applies to a workspace change too", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "personal",
      modes: { personal: "review_first", workspace: "automatic" },
    });
    const result = await fixture.editNotes();

    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.structuredContent.outcome).toBe("pending");
  }, 120_000);

  test("a new Skill saves to the workspace only when that scope is chosen", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "personal",
      modes: { personal: "automatic", workspace: "automatic" },
    });
    const create = (scope?: SkillScope) => {
      const skillId = crypto.randomUUID();
      return saveSkill(app!.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        actor: fixture.actor,
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        stableKey: `authored-${skillId.replaceAll("-", "")}`,
        ...(scope ? { scope } : {}),
        files: [{ path: "SKILL.md", content: "---\nname: rule\ndescription: Rule\n---\nBody" }],
        reason: "The person asked to remember this",
      });
    };
    const read = (skillId: string) =>
      readSkill(
        app!.db,
        {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          subjectId: fixture.subjectId,
        },
        skillId,
      );

    const personal = await create();
    expect((await read(personal.skillId))?.scope).toBe("user");
    const workspace = await create("workspace");
    expect(workspace.outcome).toBe("applied");
    expect((await read(workspace.skillId))?.scope).toBe("workspace");
    // An existing Skill keeps its own scope; naming another one is refused.
    await expect(
      saveSkill(app.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        actor: fixture.actor,
        operationId: crypto.randomUUID(),
        skillId: fixture.skillId,
        expectedRevisionId: fixture.saved.revisionId,
        expectedScopeVersion: 1,
        stableKey: "ignored",
        scope: "user",
        files: [{ path: "SKILL.md", content: "---\nname: notes\ndescription: Notes\n---\nX" }],
        reason: "Wrong scope",
      }),
    ).rejects.toThrow("Skill scope differs from the requested scope");
  }, 120_000);

  test("skill_save's scope argument creates a workspace Skill from a private chat", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "personal",
      modes: { personal: "automatic", workspace: "review_first" },
    });
    const skillId = crypto.randomUUID();
    const result = (await fixture.skillSave.execute(
      {
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        scope: "workspace",
        files: [{ path: "SKILL.md", content: "---\nname: rule\ndescription: Rule\n---\nBody" }],
        reason: "The person wants this rule for the whole workspace",
      },
      { operationId: crypto.randomUUID(), caller: { kind: "model" } } as never,
    )) as SkillSaveResult;
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    // The workspace's Review first governs the explicit workspace destination.
    expect(result.structuredContent.outcome).toBe("pending");
    const head = await readSkill(
      app.db,
      { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
      skillId,
    );
    expect(head?.scope).toBe("workspace");
  }, 120_000);

  test("an edit naming another scope is a correction for the agent, not a notice", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "personal",
      modes: { personal: "automatic", workspace: "automatic" },
    });
    // An edit that names another scope is the agent's to correct, not a notice.
    const result = (await fixture.skillSave.execute(
      {
        operationId: crypto.randomUUID(),
        skillId: fixture.skillId,
        expectedRevisionId: fixture.saved.revisionId,
        expectedScopeVersion: 1,
        scope: "personal",
        files: [{ path: "notes.md", content: "Use metric units in reports." }],
        reason: "The person wants this rule",
      },
      { operationId: crypto.randomUUID(), caller: { kind: "model" } } as never,
    )) as SkillSaveResult;
    expect(result.isError).toBe(true);
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("an edit keeps the Skill's own scope");
    expect(text).not.toContain("isn't allowed");
    expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toBeUndefined();
    expect((await fixture.readNotes())?.revisionId).toBe(fixture.saved.revisionId);
  }, 120_000);

  test("a shared chat without a person cannot choose a personal destination", async () => {
    if (!app || !shared) return;
    const fixture = await skillSaveFixture(app.db, {
      skillScope: "workspace",
      learning: "workspace",
      person: false,
    });
    const skillId = crypto.randomUUID();
    await expect(
      saveSkill(app.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        actor: fixture.actor,
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        stableKey: `authored-${skillId.replaceAll("-", "")}`,
        scope: "user",
        files: [{ path: "SKILL.md", content: "---\nname: rule\ndescription: Rule\n---\nBody" }],
        reason: "Not available",
      }),
    ).rejects.toThrow("Skill scope is not available to this chat");
  }, 120_000);
});
