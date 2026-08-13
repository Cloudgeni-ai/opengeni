import { describe, expect, test } from "bun:test";
import { sandboxWorkspaceMutationAdmissions, sessionAttemptCodemodeCalls } from "../src/schema";

describe("schema authority nullability contracts", () => {
  test("matches the deployed direct/process admission contract", () => {
    expect({
      turnId: sandboxWorkspaceMutationAdmissions.turnId.notNull,
      attemptId: sandboxWorkspaceMutationAdmissions.attemptId.notNull,
      executionGeneration: sandboxWorkspaceMutationAdmissions.executionGeneration.notNull,
    }).toEqual({
      turnId: false,
      attemptId: false,
      executionGeneration: false,
    });
  });

  test("matches the deployed Codemode exact-attempt authority contract", () => {
    expect({
      turnId: sessionAttemptCodemodeCalls.turnId.notNull,
      attemptId: sessionAttemptCodemodeCalls.attemptId.notNull,
      executionGeneration: sessionAttemptCodemodeCalls.executionGeneration.notNull,
    }).toEqual({
      turnId: true,
      attemptId: true,
      executionGeneration: true,
    });
  });
});
