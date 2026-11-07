import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LatencyMode, latencyModeForMetadata } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { and, eq } from "drizzle-orm";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getNewSessionDraftInTransaction,
  saveComposerDraftInTransaction,
  saveNewSessionDraftInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import * as schema from "../src/schema";

// Every speed a person can pick (LatencyMode is what the pickers, API and
// runtime accept) must survive each table it is stored in: the new-chat draft,
// the chat, the composer draft in a chat and the turn it sends.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("latency-modes");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspace() {
  const suffix = crypto.randomUUID();
  const subjectId = `subject-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "latency-modes-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Latency modes",
    workspaceExternalSource: "latency-modes-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Latency modes",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}

describe("every latency mode round-trips through PostgreSQL", () => {
  test("the modes under test are the full LatencyMode contract", () => {
    expect(LatencyMode.options).toEqual(["standard", "priority", "fast", "ultrafast"]);
  });

  for (const latencyMode of LatencyMode.options) {
    test(`${latencyMode}: new-chat draft, chat, composer draft and sent turn`, async () => {
      const scope = await workspace();

      const newDraft = await withWorkspaceSubjectRls(
        client.db,
        scope.workspaceId,
        scope.subjectId,
        async (db) => {
          await saveNewSessionDraftInTransaction(db, {
            ...scope,
            expectedRevision: 0,
            text: "draft",
            resources: [],
            tools: [],
            toolsProvided: false,
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode,
            options: {},
          });
          return await getNewSessionDraftInTransaction(db, scope);
        },
      );
      expect(newDraft?.latencyMode).toBe(latencyMode);

      const session = await createSession(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        initialMessage: "initial",
        resources: [],
        // Core also records the chat's speed in its metadata.
        metadata: { latencyMode },
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode,
        sandboxBackend: "none",
      });
      const [stored] = await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
        db
          .select({
            latencyMode: schema.sessions.latencyMode,
            metadata: schema.sessions.metadata,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              eq(schema.sessions.id, session.id),
            ),
          ),
      );
      expect(stored?.latencyMode).toBe(latencyMode);
      expect(latencyModeForMetadata(stored!.metadata as Record<string, unknown>)).toBe(latencyMode);

      const sessionScope = { ...scope, sessionId: session.id };
      const composer = await withWorkspaceSubjectSessionActivityRls(
        client.db,
        scope.workspaceId,
        scope.subjectId,
        async (db) => {
          const draft = await saveComposerDraftInTransaction(db, {
            ...sessionScope,
            expectedRevision: 0,
            text: "follow up",
            resources: [],
            model: "chosen-model",
            reasoningEffort: "high",
            latencyMode,
          });
          await submitHumanPromptInTransaction(db, {
            ...sessionScope,
            actor: { type: "human", subjectId: scope.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            expectedDraftRevision: draft.revision,
            text: draft.text,
            resources: [],
            model: "chosen-model",
            reasoningEffort: "high",
            latencyMode,
            reasoningEffortFallback: "medium",
            source: "user",
          });
          return draft;
        },
      );
      expect(composer.latencyMode).toBe(latencyMode);

      // The initial message is the first turn; the sent message follows it.
      const turns = await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
        db
          .select({
            prompt: schema.sessionTurns.prompt,
            latencyMode: schema.sessionTurns.latencyMode,
          })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, scope.workspaceId),
              eq(schema.sessionTurns.sessionId, session.id),
            ),
          ),
      );
      expect(turns.find((turn) => turn.prompt === "follow up")?.latencyMode).toBe(latencyMode);

      const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      expect(claimed.action).toBe("claimed");
      if (claimed.action === "claimed") expect(claimed.turn.latencyMode).toBe(latencyMode);
    });
  }
});
