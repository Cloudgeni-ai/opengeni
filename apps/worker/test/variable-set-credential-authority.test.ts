import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { SandboxSecretsRequest } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { loadWorkspaceEnvironmentForRunWithCredentials } from "../src/activities/environment";

describe("Variable Set credential authority", () => {
  test("passes a pure service initiator and null causal human to host credential providers", async () => {
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const variableSetId = crypto.randomUUID();
    const authority = {
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      initiator: {
        kind: "service" as const,
        subjectId: "scheduler",
        label: "OpenGeni scheduler",
      },
      initiatingHumanSubjectId: null,
    };
    let received: SandboxSecretsRequest | undefined;

    const loaded = await loadWorkspaceEnvironmentForRunWithCredentials(
      {} as Database,
      {} as Settings,
      { accountId, workspaceId },
      variableSetId,
      authority,
      async (request) => {
        received = request;
        return {
          accountId,
          workspaceId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          attemptId: request.attemptId,
          executionGeneration: request.executionGeneration,
          variableSetId,
          scope: "workspace",
          generation: 1,
          values: { TASK_TOKEN: "exact-value" },
        };
      },
    );

    expect(received).toEqual({
      accountId,
      workspaceId,
      variableSetId,
      ...authority,
    });
    expect(loaded?.values).toEqual({ TASK_TOKEN: "exact-value" });
  });
});
