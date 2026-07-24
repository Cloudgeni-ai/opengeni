import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type ApplySessionTurnSettlementInput,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";
import { and, desc, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-turn-settlement-evidence");
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
    accountName: "Session settlement evidence test",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session settlement evidence test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`could not claim fixture: ${claim.reason}`);
  return { grant, session, turn: claim.turn, attemptId };
}

async function persistedTurnEvent(
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<Record<string, unknown>> {
  const [event] = await withWorkspaceRls(client.db, workspaceId, (db) =>
    db
      .select({ payload: schema.sessionEvents.payload })
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, workspaceId),
          eq(schema.sessionEvents.sessionId, sessionId),
          eq(schema.sessionEvents.turnId, turnId),
          eq(schema.sessionEvents.type, "turn.completed"),
        ),
      )
      .orderBy(desc(schema.sessionEvents.sequence))
      .limit(1),
  );
  if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("settled turn event payload is missing");
  }
  return event.payload as Record<string, unknown>;
}

const largeOutput = "output-😀".repeat(40_000);

function settlementInput(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  event: ApplySessionTurnSettlementInput["events"][number],
): ApplySessionTurnSettlementInput {
  return {
    sessionId: fixtureValue.session.id,
    turnId: fixtureValue.turn.id,
    triggerEventId: fixtureValue.turn.triggerEventId,
    attemptId: fixtureValue.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [event],
  };
}

describe("atomic turn settlement retained-output evidence", () => {
  test("preserves a valid receipt through large-payload sanitization", async () => {
    const value = await fixture();
    const artifactId = crypto.randomUUID();
    const evidence = {
      available: true as const,
      artifactId,
      kind: "assistant_completion" as const,
      contentType: "text/plain",
      originalBytes: 5_000_000,
      sha256: "a".repeat(64),
      retainedAt: new Date().toISOString(),
      retention: { policy: "workspace_file" as const, expiresAt: null },
      retrieval: {
        method: "GET" as const,
        path: `/v1/workspaces/${value.grant.workspaceId}/artifacts/${artifactId}/content`,
        acceptRanges: "bytes" as const,
        maxRangeBytes: 1024 * 1024,
      },
    };

    const settled = await applySessionTurnSettlement(
      client.db,
      value.grant.workspaceId!,
      settlementInput(value, {
        type: "turn.completed",
        payload: { output: largeOutput },
        retainedOutputEvidence: evidence,
      }),
    );
    expect(settled.action).toBe("settled");

    const payload = await persistedTurnEvent(
      value.grant.workspaceId!,
      value.session.id,
      value.turn.id,
    );
    expect(payload.output).toBeDefined();
    expect(payload.truncation).toMatchObject({
      truncated: true,
      fullEvidence: evidence,
    });
  });

  test("fails closed for malformed retained-output evidence", async () => {
    const value = await fixture();
    const settled = await applySessionTurnSettlement(
      client.db,
      value.grant.workspaceId!,
      settlementInput(value, {
        type: "turn.completed",
        payload: { output: largeOutput },
        retainedOutputEvidence: {
          available: true,
          artifactId: "not-an-artifact-id",
          kind: "assistant_completion",
        },
      }),
    );
    expect(settled.action).toBe("settled");

    const payload = await persistedTurnEvent(
      value.grant.workspaceId!,
      value.session.id,
      value.turn.id,
    );
    expect(payload.truncation).toMatchObject({
      truncated: true,
      fullEvidence: { available: false, reason: "not_retained" },
    });
  });

  test("keeps ordinary no-evidence settlement behavior unchanged", async () => {
    const value = await fixture();
    const settled = await applySessionTurnSettlement(
      client.db,
      value.grant.workspaceId!,
      settlementInput(value, {
        type: "turn.completed",
        payload: { output: largeOutput },
      }),
    );
    expect(settled.action).toBe("settled");

    const payload = await persistedTurnEvent(
      value.grant.workspaceId!,
      value.session.id,
      value.turn.id,
    );
    expect(payload.truncation).toMatchObject({
      truncated: true,
      fullEvidence: { available: false, reason: "not_retained" },
    });
  });
});
