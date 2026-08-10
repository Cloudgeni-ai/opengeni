import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  correctWorkspaceMemory,
  createDurableLearningAttemptLedger,
  createDb,
  saveWorkspaceMemory,
} from "@opengeni/db";
import { DURABLE_LEARNING_CONTRACT_VERSION } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createWorkspaceMemoryDurableLearningAdapter,
  routeLegacyWorkspaceMemoryWrite,
} from "../src/domain/durable-learning-memory-adapter";
import { routeDurableLearning } from "../src/domain/durable-learning-router";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("durable-learning-memory-adapter");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[durable-learning-memory-adapter] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("Workspace Memory durable-learning adapter", () => {
  test("persists every canonical Memory subject with its deliberate Memory kind", async () => {
    if (!client) return;
    const suffix = randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "durable-learning-memory-kind",
      accountExternalId: `account-${suffix}`,
      accountName: "Durable learning Memory kinds",
      workspaceExternalSource: "durable-learning-memory-kind",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Durable learning Memory kinds",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const cases = [
      ["fact", "semantic"],
      ["observation", "semantic"],
      ["decision", "decision"],
      ["history", "episodic"],
    ] as const;

    for (const [subjectKind, memoryKind] of cases) {
      let writeResult: Awaited<ReturnType<typeof saveWorkspaceMemory>> | null = null;
      const response = await routeDurableLearning(
        {
          contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
          operation: "write",
          attemptId: randomUUID(),
          origin: "explicit_remember",
          requestedAuthority: "active",
          requestedScope: { kind: "workspace" },
          targetSurface: "memory",
          subject: {
            kind: subjectKind,
            content: `Canonical ${subjectKind} subject ${suffix}`,
            stableKey: null,
            title: null,
            summary: null,
            roleKey: null,
            replacesResourceId: null,
            legacyMemory: null,
          },
          evidence: [],
        },
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          actor: { kind: "human", subjectId: grant.subjectId },
          initiatingHumanSubjectId: grant.subjectId,
          sessionId: null,
          grants: {
            organization: false,
            workspace: true,
            selfUser: false,
            roleKeys: [],
            sessionIds: [],
            ephemeralSessionIds: [],
            activate: true,
          },
          learningPolicy: null,
          availableSurfaces: {
            memory: true,
            preferenceRegistry: false,
            instructionPolicy: false,
            companyProfile: false,
            documentsEvidence: false,
          },
        },
        {
          ledger: createDurableLearningAttemptLedger(client.db),
          authorities: {
            memory: createWorkspaceMemoryDurableLearningAdapter({
              db: client.db,
              onWriteResult: (result) => {
                writeResult = result;
              },
            }),
          },
        },
      );

      expect(response).toMatchObject({
        idempotency: "created",
        receipt: { outcome: "applied", resource: { surface: "memory" } },
      });
      expect(writeResult?.memory.kind).toBe(memoryKind);
    }
  });

  test("reconstructs stable create, update, and supersession replays", async () => {
    if (!client) return;
    const suffix = randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "durable-learning-memory-adapter",
      accountExternalId: `account-${suffix}`,
      accountName: "Durable learning Memory adapter",
      workspaceExternalSource: "durable-learning-memory-adapter",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Durable learning Memory adapter",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const base = {
      db: client.db,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: null,
      actor: { kind: "human" as const, subjectId: grant.subjectId },
      initiatingHumanSubjectId: grant.subjectId,
    };

    const created = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Create through one stable durable operation",
      kind: "semantic",
    });
    const createdReplay = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Create through one stable durable operation",
      kind: "semantic",
    });
    expect(created.router.idempotency).toBe("created");
    expect(createdReplay.router.idempotency).toBe("replayed");
    expect(createdReplay.memory?.memory.id).toBe(created.memory?.memory.id);

    const updated = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Create through one stable durable operation",
      kind: "decision",
      replacesId: created.memory!.memory.id.slice(0, 8),
    });
    const updatedReplay = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Create through one stable durable operation",
      kind: "decision",
      replacesId: created.memory!.memory.id.slice(0, 8),
    });
    expect(updated.memory?.updated).toBe(true);
    expect(updatedReplay.router.idempotency).toBe("replayed");
    expect(updatedReplay.memory).toMatchObject({
      memory: { id: updated.memory!.memory.id },
      updated: true,
      superseded: null,
    });
    const createdAfterUpdate = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Create through one stable durable operation",
      kind: "semantic",
    });
    expect(createdAfterUpdate.router.idempotency).toBe("replayed");
    expect(createdAfterUpdate.memory).toEqual(created.memory);

    const superseded = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Replacement through one stable durable operation",
      kind: "decision",
      replacesId: updated.memory!.memory.id.slice(0, 8),
    });
    const supersededReplay = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Replacement through one stable durable operation",
      kind: "decision",
      replacesId: updated.memory!.memory.id.slice(0, 8),
    });
    expect(superseded.memory?.superseded?.id).toBe(updated.memory!.memory.id);
    expect(supersededReplay.router.idempotency).toBe("replayed");
    expect(supersededReplay.memory).toMatchObject({
      memory: { id: superseded.memory!.memory.id },
      superseded: { id: updated.memory!.memory.id },
      updated: false,
    });
    await correctWorkspaceMemory(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: superseded.memory!.memory.id,
      reason: "change lifecycle after the immutable replacement result",
    });
    const supersededAfterArchive = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: "Replacement through one stable durable operation",
      kind: "decision",
      replacesId: updated.memory!.memory.id.slice(0, 8),
    });
    expect(supersededAfterArchive.router.idempotency).toBe("replayed");
    expect(supersededAfterArchive.memory).toEqual(superseded.memory);

    const noOpWinner = await saveWorkspaceMemory(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "No-op compatibility result survives lifecycle changes",
      kind: "semantic",
      origin: "human",
    });
    const noOp = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: noOpWinner.memory.text,
      kind: "semantic",
    });
    expect(noOp.router.receipt.outcome).toBe("noop");
    expect(noOp.memory).toMatchObject({
      memory: { id: noOpWinner.memory.id, status: "active" },
      deduped: true,
    });
    await correctWorkspaceMemory(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: noOpWinner.memory.id,
      reason: "archive after the immutable no-op result",
    });
    const noOpAfterArchive = await routeLegacyWorkspaceMemoryWrite({
      ...base,
      text: noOpWinner.memory.text,
      kind: "semantic",
    });
    expect(noOpAfterArchive.router.idempotency).toBe("replayed");
    expect(noOpAfterArchive.memory).toEqual(noOp.memory);
  });
});
