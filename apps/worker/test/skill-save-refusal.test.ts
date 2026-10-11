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
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { readSkill, saveSkill } from "@opengeni/core";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";

// A Skill change the lifecycle refuses rolls back as a whole. The agent must
// get a definite refusal with the reason, not a failed query that repeats
// every parameter (the Skill's text included) and leaves the outcome unknown.
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

describe("skill_save refusals", () => {
  test("a personal Skill edited from a workspace-learning chat is refused with its reason", async () => {
    if (!app || !shared) return;
    const db = app.db;
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
      stableKey: `personal-${suffix}`,
      scope: "user",
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: personal-notes\ndescription: Personal notes\n---\n${privateText}`,
        },
      ],
      reason: "Fixture",
    });

    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "Update my notes Skill",
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
    const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
    const definitions = createWorkspaceSkillTools({
      db,
      settings,
      accountId,
      workspaceId,
      subjectId,
      actor: {
        kind: "agent",
        accountId,
        workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
      },
      selected: [],
      filesystem: async () => {
        throw new Error("skill_save needs no sandbox");
      },
      modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
    });
    const skillSave = definitions.find((definition) => definition.modelName === "skill_save")!;

    const result = (await skillSave.execute(
      {
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: saved.revisionId,
        expectedScopeVersion: 1,
        files: [{ path: "notes.md", content: "More notes" }],
        reason: "Add notes",
      },
      { operationId: crypto.randomUUID(), caller: { kind: "model" } } as never,
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { error: { code: string; message: string; retryable: boolean } };
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("skill_change_refused");
    expect(result.structuredContent.error.retryable).toBe(false);
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("different scope");
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain(privateText);
    // Nothing was saved.
    const after = await readSkill(db, { accountId, workspaceId, subjectId }, skillId);
    expect(after?.revisionId).toBe(saved.revisionId);
  }, 120_000);
});
