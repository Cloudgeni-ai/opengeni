import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { testSettings } from "@opengeni/testing/settings";
import type { AccessGrant, CreateScheduledTaskRequest } from "@opengeni/contracts";
import { createValidatedScheduledTask } from "@opengeni/core";

// The model allow-list rejects curated-out models before any database access.
// Allowed/default models reach the Personal-workspace authority read; permit
// that real read, then refuse downstream creation work.
const SENTINEL = "reached-db-past-the-model-guard";
const settings = testSettings();
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let grant: AccessGrant;
beforeAll(async () => {
  const value = await acquireSharedTestDatabase("scheduled-task-model-guard");
  if (!value) throw new Error("Scheduled-task model guard requires real PostgreSQL");
  shared = value;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "scheduled-model-guard",
    accountExternalId: crypto.randomUUID(),
    accountName: "Model guard",
    workspaceExternalSource: "scheduled-model-guard",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Model guard",
    subjectId: `user:${crypto.randomUUID()}`,
  });
  grant = access.workspaceGrants[0]!;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

function payload(model?: string): CreateScheduledTaskRequest {
  return {
    name: "nightly digest",
    schedule: { type: "interval", everySeconds: 86400 },
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    status: "active",
    metadata: {},
    agentConfig: {
      prompt: "Summarize yesterday's activity.",
      resources: [],
      tools: [],
      metadata: {},
      ...(model !== undefined ? { model } : {}),
    },
  };
}

async function createWith(model?: string) {
  let dbAccesses = 0;
  let authorityReadCompleted = false;
  const db = new Proxy(client.db, {
    get(target, key, receiver) {
      dbAccesses++;
      if (key === "transaction") {
        return async (...args: Parameters<typeof target.transaction>) => {
          if (authorityReadCompleted) throw new Error(SENTINEL);
          const result = await target.transaction(...args);
          authorityReadCompleted = true;
          return result;
        };
      }
      if (authorityReadCompleted) throw new Error(SENTINEL);
      return Reflect.get(target, key, receiver);
    },
  });
  let thrown: unknown;
  try {
    await createValidatedScheduledTask({
      settings,
      db,
      objectStorage: undefined,
      grant,
      payload: payload(model),
      toolsProvided: true,
    });
  } catch (error) {
    thrown = error;
  }
  return { thrown, authorityReadCompleted, dbAccesses };
}

describe("scheduled-task model allow-list guard", () => {
  test("rejects a curated-out model with 422 before any database access", async () => {
    const { thrown, authorityReadCompleted, dbAccesses } = await createWith("forbidden-model");
    expect(authorityReadCompleted).toBe(false);
    expect(dbAccesses).toBe(0);
    expect(thrown).toBeInstanceOf(HTTPException);
    expect((thrown as HTTPException).status).toBe(422);
    expect((thrown as HTTPException).message).toBe("model is not available: forbidden-model");
  });

  test("an allowed model passes the guard (fails only later, at the db)", async () => {
    const { thrown, authorityReadCompleted, dbAccesses } = await createWith("gpt-5.6-sol");
    expect(authorityReadCompleted).toBe(true);
    expect(dbAccesses).toBeGreaterThan(0);
    // The allowed model is NOT the thing that fails: we got past the guard and
    // hit the stubbed db sentinel instead of an HTTPException model rejection.
    expect(thrown).not.toBeInstanceOf(HTTPException);
    expect((thrown as Error).message).toBe(SENTINEL);
  });

  test("an omitted model passes the guard (inherits the host default downstream)", async () => {
    const { thrown, authorityReadCompleted, dbAccesses } = await createWith(undefined);
    expect(authorityReadCompleted).toBe(true);
    expect(dbAccesses).toBeGreaterThan(0);
    expect(thrown).not.toBeInstanceOf(HTTPException);
    expect((thrown as Error).message).toBe(SENTINEL);
  });
});
