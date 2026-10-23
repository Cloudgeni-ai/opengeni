import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { testSettings } from "@opengeni/testing/settings";
import type { AccessGrant, CreateScheduledTaskRequest } from "@opengeni/contracts";
import { createValidatedScheduledTask } from "@opengeni/core";

// The organization Personal-workspace gate precedes model validation. Exercise
// that authority read against PostgreSQL, then refuse any downstream database
// operation so these cases still prove where model validation stops creation.
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

async function createWith(model?: string): Promise<unknown> {
  let authorityReadCompleted = false;
  const db = new Proxy(client.db, {
    get(target, key, receiver) {
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
  try {
    return await createValidatedScheduledTask({
      settings,
      db,
      objectStorage: undefined,
      grant,
      payload: payload(model),
      toolsProvided: true,
    });
  } finally {
    expect(authorityReadCompleted).toBe(true);
  }
}

describe("scheduled-task model allow-list guard", () => {
  test("rejects a curated-out model with 422 after authority read and before downstream db work", async () => {
    let thrown: unknown;
    try {
      await createWith("forbidden-model");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    expect((thrown as HTTPException).status).toBe(422);
    expect((thrown as HTTPException).message).toBe("model is not available: forbidden-model");
  });

  test("an allowed model passes the guard (fails only later, at the db)", async () => {
    let thrown: unknown;
    try {
      await createWith("gpt-5.6-sol");
    } catch (error) {
      thrown = error;
    }
    // The allowed model is NOT the thing that fails: we got past the guard and
    // hit the stubbed db sentinel instead of an HTTPException model rejection.
    expect(thrown).not.toBeInstanceOf(HTTPException);
    expect((thrown as Error).message).toBe(SENTINEL);
  });

  test("an omitted model passes the guard (inherits the host default downstream)", async () => {
    let thrown: unknown;
    try {
      await createWith(undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(HTTPException);
    expect((thrown as Error).message).toBe(SENTINEL);
  });
});
