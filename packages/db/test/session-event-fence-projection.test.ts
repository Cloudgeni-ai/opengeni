import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  lockTurnAttemptWriteFenceTx,
  withWorkspaceRls,
} from "../src/index";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("event-fence-projection");
  if (!acquired) throw new Error("Restricted PostgreSQL fixture required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function fixture() {
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Fence projection",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Fence projection",
    subjectId: id,
  });
  if (!grant) throw new Error("Missing fixture grant");
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "exact input",
    instructions: "full-row caller instructions",
    resources: [],
    metadata: { retained: "session metadata" },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await submitTestHumanPrompt(client.db, {
    ...grant,
    sessionId: session.id,
    text: "exact prompt",
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    attemptId,
    dispatchId: crypto.randomUUID(),
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Missing fixture claim");
  return {
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
  };
}

test("compact and full projections use identical fence decisions; full callers retain their rows", async () => {
  const input = await fixture();
  for (const sessionLock of ["no_key_update", "key_share"] as const) {
    await withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
      const full = await lockTurnAttemptWriteFenceTx(tx, { ...input, sessionLock });
      const narrow = await lockTurnAttemptWriteFenceTx(tx, {
        ...input,
        sessionLock,
        rowProjection: "event",
      });
      expect(full.allowed).toBe(true);
      expect(narrow.allowed).toBe(true);
      if (!full.allowed || !narrow.allowed) throw new Error("Fixture fence rejected");
      for (const name of ["workspace", "session", "turn", "attempt"] as const) {
        for (const key of Object.keys(narrow[name])) {
          expect((narrow[name] as unknown as Record<string, unknown>)[key]).toEqual(
            (full[name] as unknown as Record<string, unknown>)[key],
          );
        }
        expect(Object.keys(narrow[name]).length).toBeLessThan(Object.keys(full[name]).length);
      }
      expect(full.session.instructions).toBe("full-row caller instructions");
      expect(full.turn.prompt).toBe("exact prompt");
      expect(full.attempt.mcpApprovalPolicies).toBeDefined();
      expect(narrow.session).not.toHaveProperty("instructions");
      expect(narrow.turn).not.toHaveProperty("prompt");
      expect(narrow.attempt).not.toHaveProperty("mcpApprovalPolicies");
    });
  }
  for (const changed of [
    { executionGeneration: input.executionGeneration + 1 },
    { sessionId: crypto.randomUUID() },
    { turnId: crypto.randomUUID() },
    { attemptId: crypto.randomUUID() },
  ]) {
    await withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
      const full = await lockTurnAttemptWriteFenceTx(tx, { ...input, ...changed });
      const narrow = await lockTurnAttemptWriteFenceTx(tx, {
        ...input,
        ...changed,
        rowProjection: "event",
      });
      expect(full.allowed).toBe(false);
      expect(narrow.allowed).toBe(false);
      if (full.allowed || narrow.allowed) throw new Error("Incorrect attempt admitted");
      expect(narrow.reason).toBe(full.reason);
    });
  }
});

test("plain appends omit wide frozen columns but mutation callbacks retain the public contract", async () => {
  const input = await fixture();
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  driver.options.debug = (_connection, query) => queries.push(query);
  try {
    for (const type of ["agent.message.delta", "agent.message.completed"] as const) {
      queries.length = 0;
      const result = await appendSessionEventsForTurnAttempt(
        client.db,
        input.workspaceId,
        input.sessionId,
        input.turnId,
        input.executionGeneration,
        input.attemptId,
        [{ type, payload: { text: "unchanged bytes" } }],
      );
      expect(result.accepted).toBe(true);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.payload).toEqual({ text: "unchanged bytes" });
      const sessionReads = queries.filter(
        (query) => /from "sessions"/.test(query) && /for (?:key share|no key update)/.test(query),
      );
      expect(sessionReads).toHaveLength(type === "agent.message.delta" ? 2 : 1);
      for (const query of sessionReads) {
        expect(query).not.toContain('"instructions"');
        expect(query).not.toContain('"initial_message"');
        expect(query).toContain('"execution_authority_epoch"');
      }
    }
    let invoked = false;
    const result = await appendSessionEventsForTurnAttempt(
      client.db,
      input.workspaceId,
      input.sessionId,
      input.turnId,
      input.executionGeneration,
      input.attemptId,
      [{ type: "agent.message.completed", payload: { text: "callback bytes" } }],
      undefined,
      async (_tx, fence) => {
        expect(fence.allowed).toBe(true);
        if (!fence.allowed) return false;
        expect(fence.session.instructions).toBe("full-row caller instructions");
        expect(fence.turn.prompt).toBe("exact prompt");
        expect(fence.attempt.mcpApprovalPolicies).toBeDefined();
        invoked = true;
        return true;
      },
    );
    expect(invoked).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.events[0]!.payload).toEqual({ text: "callback bytes" });
  } finally {
    driver.options.debug = false;
  }
});
