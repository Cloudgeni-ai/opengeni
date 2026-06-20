import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { testSettings } from "@opengeni/testing";
import type { AccessGrant, CreateScheduledTaskRequest } from "@opengeni/contracts";
import { createValidatedScheduledTask } from "../src/domain/scheduled-tasks";

// A scheduled task is a session the worker runs later, so its agentConfig.model
// must pass the same host allow-list as the session choke points. The guard is
// the first statement in the shared validator, so a curated-out model is
// rejected with HTTPException(422) BEFORE any DB/object-storage access — which
// lets these tests stay hermetic: the db/objectStorage stubs throw a sentinel
// if (and only if) the guard let the request through.
const SENTINEL = "reached-db-past-the-model-guard";

const settings = testSettings(); // allow-list: scripted-model, gpt-5.5, gpt-5.4, gpt-5.4-mini

function throwingDb(): never {
  throw new Error(SENTINEL);
}

const grant: AccessGrant = {
  workspaceId: crypto.randomUUID(),
  accountId: crypto.randomUUID(),
  subjectId: "tester",
  permissions: ["scheduled_tasks:manage"],
};

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

function createWith(model?: string): Promise<unknown> {
  return createValidatedScheduledTask({
    settings,
    // Stubs: only reached if the model guard passes. A curated-out model must
    // never get here.
    db: new Proxy({}, { get: throwingDb, apply: throwingDb }) as never,
    objectStorage: undefined,
    grant,
    payload: payload(model),
    toolsProvided: true,
  });
}

describe("scheduled-task model allow-list guard", () => {
  test("rejects a curated-out model with 422 before touching the db", async () => {
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
      await createWith("gpt-5.5");
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
