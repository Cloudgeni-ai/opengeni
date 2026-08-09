import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  DURABLE_LEARNING_CONTRACT_VERSION,
  type DurableLearningAttempt,
  type DurableLearningReceipt,
} from "@opengeni/contracts";
import { eq } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createDurableLearningAttemptLedger,
  DurableLearningLedgerConflictError,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current) && messages.length < 16) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("durable-learning-router");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[durable-learning-router] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspace(label: string) {
  const suffix = randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "durable-learning-test",
    accountExternalId: `account-${label}-${suffix}`,
    accountName: `Durable learning ${label}`,
    workspaceExternalSource: "durable-learning-test",
    workspaceExternalId: `workspace-${label}-${suffix}`,
    workspaceName: `Durable learning ${label}`,
    subjectId: `human:${label}:${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

function learningAttempt(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  attemptId?: string;
  content?: string;
}): DurableLearningAttempt {
  const attemptId = input.attemptId ?? randomUUID();
  const content = input.content ?? "Use one canonical durable-learning router.";
  return {
    id: attemptId,
    contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    inputHash:
      content === "Use one canonical durable-learning router." ? "a".repeat(64) : "b".repeat(64),
    request: {
      contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
      operation: "write",
      attemptId,
      origin: "legacy_memory_save",
      requestedAuthority: "active",
      requestedScope: { kind: "workspace" },
      targetSurface: "memory",
      subject: {
        kind: "fact",
        content,
        stableKey: null,
        title: null,
        summary: null,
        roleKey: null,
        replacesResourceId: null,
        legacyMemory: {
          kind: "semantic",
          confidence: null,
          pinned: null,
          metadata: {},
        },
      },
      evidence: [],
    },
    actor: { kind: "human", subjectId: input.subjectId },
    initiatingHumanSubjectId: input.subjectId,
    sessionId: null,
    createdAt: "2026-08-09T16:00:00.000Z",
  };
}

function receipt(attempt: DurableLearningAttempt): DurableLearningReceipt {
  return {
    contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
    attemptId: attempt.id,
    inputHash: attempt.inputHash,
    outcome: "applied",
    decision: {
      disposition: "route",
      code: "ROUTED",
      destination: "memory",
      scope: { kind: "workspace" },
      authority: "active",
      policySnapshotId: null,
      reasons: ["Routed exactly once to memory."],
      clarificationFields: [],
    },
    resource: {
      surface: "memory",
      id: randomUUID(),
      version: "1",
      status: "active",
    },
    effectiveBoundary: "next_accepted_attempt",
    rollback: {
      supported: true,
      targetAttemptId: null,
      token: `memory:${randomUUID()}`,
    },
    createdAt: "2026-08-09T16:00:01.000Z",
  };
}

describe("durable learning Postgres ledger", () => {
  test("replays one immutable attempt and terminal receipt", async () => {
    if (!client) return;
    const grant = await workspace("replay");
    const ledger = createDurableLearningAttemptLedger(client.db);
    const writeAttempt = learningAttempt({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
    });
    const first = await ledger.reserveAttempt(writeAttempt);
    expect(first).toMatchObject({ attempt: writeAttempt, receipt: null });
    expect(first.claimId).toBeString();
    expect((await ledger.reserveAttempt(writeAttempt)).claimId).toBeNull();
    const terminal = receipt(writeAttempt);
    expect(await ledger.completeAttempt(writeAttempt, terminal, first.claimId!)).toEqual(terminal);
    expect(await ledger.reserveAttempt(writeAttempt)).toEqual({
      attempt: writeAttempt,
      receipt: terminal,
      claimId: null,
    });
    expect(
      await ledger.getCompletedAttempt(grant.accountId, grant.workspaceId, writeAttempt.id),
    ).toEqual({ attempt: writeAttempt, receipt: terminal });
  });

  test("rejects changed input and hides attempts across workspaces", async () => {
    if (!client) return;
    const left = await workspace("left");
    const right = await workspace("right");
    const ledger = createDurableLearningAttemptLedger(client.db);
    const original = learningAttempt({
      accountId: left.accountId,
      workspaceId: left.workspaceId,
      subjectId: left.subjectId,
    });
    await ledger.reserveAttempt(original);
    await expect(
      ledger.reserveAttempt(
        learningAttempt({
          accountId: left.accountId,
          workspaceId: left.workspaceId,
          subjectId: left.subjectId,
          attemptId: original.id,
          content: "Changed input under the same attempt id.",
        }),
      ),
    ).rejects.toBeInstanceOf(DurableLearningLedgerConflictError);
    expect(
      await ledger.getCompletedAttempt(right.accountId, right.workspaceId, original.id),
    ).toBeNull();
  });

  test("denies direct mutation of append-only attempts to the runtime role", async () => {
    if (!client) return;
    const grant = await workspace("immutable");
    const ledger = createDurableLearningAttemptLedger(client.db);
    const writeAttempt = learningAttempt({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
    });
    await ledger.reserveAttempt(writeAttempt);
    let failure: unknown;
    try {
      await withWorkspaceRls(client.db, grant.workspaceId, async (scopedDb) =>
        scopedDb
          .update(schema.durableLearningAttempts)
          .set({ inputHash: "c".repeat(64) })
          .where(eq(schema.durableLearningAttempts.id, writeAttempt.id)),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    // The application role is INSERT-only on immutable audit evidence. The
    // owner-level mutation trigger remains a separately asserted defense in depth.
    expect(errorChainMessage(failure)).toContain(
      "permission denied for table durable_learning_attempts",
    );
  });
});
