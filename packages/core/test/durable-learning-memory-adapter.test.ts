import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { bootstrapWorkspace, createDb } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { routeLegacyWorkspaceMemoryWrite } from "../src/domain/durable-learning-memory-adapter";

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
  });
});
