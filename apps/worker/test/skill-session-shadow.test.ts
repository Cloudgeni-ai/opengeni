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
import { saveSkill } from "@opengeni/core";
import {
  createWorkspaceSkillTools,
  sessionShadowedSkillNames,
  withoutSessionShadowedSkills,
} from "../src/activities/agent-turn/skill-tools";
import { loadConfiguredBundledSkills } from "../src/activities/agent-turn/skill-selection";

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("skill-session-shadow");
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

const skillFile = (name: string, body: string) => ({
  path: "SKILL.md",
  content: `---\nname: ${name}\ndescription: ${name} guidance\n---\n${body}`,
});

describe("session Skills shadow workspace Skills of the same name", () => {
  test("only session Skills shadow, and only by exact name", () => {
    const shadowed = sessionShadowedSkillNames([
      { id: "builtin:opengeni-help", artifact: { name: "opengeni-help" } },
      { id: "session:s1:quarterly-close", artifact: { name: "quarterly-close" } },
    ]);
    expect([...shadowed]).toEqual(["quarterly-close"]);
    const descriptors = [
      { id: "a", title: "quarterly-close" },
      { id: "b", title: "opengeni-help" },
      { id: "c", title: "Quarterly-Close" },
    ];
    expect(withoutSessionShadowedSkills(descriptors, shadowed).map((entry) => entry.id)).toEqual([
      "b",
      "c",
    ]);
    expect(withoutSessionShadowedSkills(descriptors, new Set())).toEqual(descriptors);
  });

  test("by-name reads and search resolve to the session copy; the exact workspace id still reads", async () => {
    if (!app || !shared) return;
    const db = app.db;
    const suffix = crypto.randomUUID();
    const subjectId = `user:skill-session-shadow-${suffix}`;
    const grant = (
      await bootstrapWorkspace(db, {
        accountExternalSource: "skill-session-shadow-test",
        accountExternalId: suffix,
        accountName: "Test",
        workspaceExternalSource: "skill-session-shadow-test",
        workspaceExternalId: suffix,
        workspaceName: "Test",
        subjectId,
      })
    ).workspaceGrants[0]!;
    const accountId = grant.accountId;
    const workspaceId = grant.workspaceId!;
    const workspaceSkillId = crypto.randomUUID();
    const otherSkillId = crypto.randomUUID();
    for (const [skillId, name, body] of [
      [workspaceSkillId, "quarterly-close", "Workspace steps."],
      [otherSkillId, "product-analytics", "Analytics steps."],
    ] as const) {
      await saveSkill(db, {
        accountId,
        workspaceId,
        actor: { kind: "human", subjectId, principalKind: "human_session" },
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        stableKey: `${name}-${suffix}`,
        files: [skillFile(name, body)],
        reason: "Fixture",
      });
    }

    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "Close the quarter",
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
    const sessionSkillId = `session:${session.id}:quarterly-close`;
    const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
    const definitions = createWorkspaceSkillTools({
      db,
      settings,
      accountId,
      workspaceId,
      actor: {
        kind: "agent",
        sessionId: session.id,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
      },
      selected: [
        ...loadConfiguredBundledSkills({
          firstPartyTools: [],
          videoGenerationEnabled: false,
          bundledSkillIds: ["builtin:opengeni-help"],
        }),
        {
          id: sessionSkillId,
          artifact: {
            name: "quarterly-close",
            description: "quarterly-close guidance",
            files: [skillFile("quarterly-close", "Session steps.")],
          },
        },
      ],
      filesystem: async () => {
        throw new Error("reads must not start a sandbox");
      },
      modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
    });
    const call = async (modelName: string, args: Record<string, unknown>) =>
      JSON.stringify(
        await definitions
          .find((definition) => definition.modelName === modelName)!
          .execute(args, {
            operationId: crypto.randomUUID(),
            caller: { kind: "model", subjectId: "agent:test" },
          }),
      );

    // The name used to match both copies and fail as ambiguous.
    const byName = await call("skill_read", { skill: "quarterly-close" });
    expect(byName).toContain("Session steps.");
    expect(byName).not.toContain("Workspace steps.");
    expect(await call("skill_read", { skill: workspaceSkillId })).toContain("Workspace steps.");
    expect(await call("skill_read", { skill: "product-analytics" })).toContain("Analytics steps.");

    const search = await call("skill_search", { query: "quarterly-close" });
    expect(search).toContain(sessionSkillId);
    expect(search).not.toContain(workspaceSkillId);
  }, 180_000);
});
