import { describe, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import {
  isPersonalMachineAccessRefusal,
  MACHINE_ACCESS_REQUIRED_CODE,
  PersonalMachineAccessRequiredError,
} from "../src/activities/agent-turn/machine-access";
import { resolveMachineEnrollmentForTurn } from "../src/activities/agent-turn/sandbox-establish";

/** A refusal shaped like the driver's, under a query wrapper. */
function databaseRefusal(code: string, message: string): Error {
  const driver = Object.assign(new Error(message), {
    name: "PostgresError",
    code,
    severity: "ERROR",
    routine: "exec_stmt_raise",
    where: "PL/pgSQL function assert_session_attempt_personal_machine(uuid) line 40 at RAISE",
  });
  return new Error("Failed query: select * from get_session_attempt_machine($1)", {
    cause: driver,
  });
}

const authority = {
  accountId: "account",
  workspaceId: "workspace",
  sessionId: "session",
  turnId: "turn",
  attemptId: "attempt",
  executionGeneration: 1,
  subjectId: "owner",
};
const sandbox = {
  id: "machine",
  name: "Studio Mac",
  scope: "user",
  workspaceId: "workspace",
  enrollmentId: "machine-enrollment",
} as never;

describe("a turn whose personal machine isn't allowed", () => {
  test.each([
    ["42501", "personal machine authority is no longer live"],
    ["42501", "personal machine use requires explicit grant"],
    ["OG002", "matching personal-resource grant required"],
  ])("the database's %s refusal (%s) is a machine access refusal", (code, message) => {
    expect(isPersonalMachineAccessRefusal(databaseRefusal(code, message))).toBe(true);
  });

  test("other refusals keep their own classification", () => {
    expect(isPersonalMachineAccessRefusal(databaseRefusal("42501", "attempt is not current"))).toBe(
      false,
    );
    expect(
      isPersonalMachineAccessRefusal(
        databaseRefusal("40001", "personal machine authority is no longer live"),
      ),
    ).toBe(false);
    expect(
      isPersonalMachineAccessRefusal(new Error("personal machine use requires explicit grant")),
    ).toBe(false);
  });

  test("ends the turn with machine access needed, not a database error", async () => {
    const refusal = databaseRefusal("42501", "personal machine authority is no longer live");
    // Before the fix this refusal surfaced as the generic database failure.
    expect(agentRunFailurePayload(refusal).code).toBe("db_failure");
    const resolver = spyOn(db, "resolvePersonalMachineRouteForAttempt").mockRejectedValue(refusal);
    try {
      const failure = await resolveMachineEnrollmentForTurn({} as never, sandbox, authority).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PersonalMachineAccessRequiredError);
      expect((failure as Error).cause).toBe(refusal);
      const payload = agentRunFailurePayload(failure);
      expect(payload).toEqual({
        error:
          "Machine access needed: this chat isn’t allowed to use “Studio Mac” right now.",
        code: MACHINE_ACCESS_REQUIRED_CODE,
        retryable: false,
      });
      expect(JSON.stringify(payload)).not.toContain("database");
      // However startup wraps it.
      expect(
        agentRunFailurePayload(new Error("sandbox establishment failed", { cause: failure })).code,
      ).toBe(MACHINE_ACCESS_REQUIRED_CODE);
    } finally {
      resolver.mockRestore();
    }
  });

  test("a turn the database didn't admit on the machine needs access too", async () => {
    const resolver = spyOn(db, "resolvePersonalMachineRouteForAttempt").mockResolvedValue(null);
    try {
      await expect(
        resolveMachineEnrollmentForTurn({} as never, sandbox, authority),
      ).rejects.toBeInstanceOf(PersonalMachineAccessRequiredError);
    } finally {
      resolver.mockRestore();
    }
  });

  test("any other database failure is still a database failure", async () => {
    const other = databaseRefusal("23505", "duplicate key value violates unique constraint");
    const resolver = spyOn(db, "resolvePersonalMachineRouteForAttempt").mockRejectedValue(other);
    try {
      await expect(resolveMachineEnrollmentForTurn({} as never, sandbox, authority)).rejects.toBe(
        other,
      );
    } finally {
      resolver.mockRestore();
    }
  });
});
