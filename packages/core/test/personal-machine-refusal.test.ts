import { describe, expect, test } from "bun:test";
import { machineAccessNeededMessage } from "@opengeni/contracts/machine-access";
import { PersonalMachineAuthorityNotLiveError } from "@opengeni/db";
import { personalMachineRefusal } from "../src/sandbox/fleet";

/** A refusal shaped like the driver's, under Drizzle's query wrapper. */
function databaseRefusal(statement: string, code: string, message: string): Error {
  const driver = Object.assign(new Error(message), {
    name: "PostgresError",
    code,
    severity: "ERROR",
    routine: "exec_stmt_raise",
    where: `PL/pgSQL function ${statement}(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean) line 40 at RAISE`,
  });
  return new Error(`Failed query: select ${statement}($1::uuid, $2::uuid) as authorized`, {
    cause: driver,
  });
}

describe("an agent's move onto a personal machine its turn may no longer use", () => {
  test.each([
    ["42501", "personal machine authority is no longer live"],
    ["OG002", "matching personal-resource grant required"],
  ])(
    "the check right before use (%s %s) says machine access is needed, never a database error",
    (code, message) => {
      const refusal = personalMachineRefusal(
        databaseRefusal("assert_session_attempt_personal_machine", code, message),
        "Studio Mac",
      );
      expect(refusal?.code).toBe("machine_access_required");
      expect(refusal?.reason).toStartWith(machineAccessNeededMessage("Studio Mac"));
      expect(refusal?.reason).not.toContain("database");
      expect(refusal?.reason).not.toContain(message);
    },
  );

  test("an approval that was not live after the move says the same, naming the machine when known", () => {
    const named = personalMachineRefusal(new PersonalMachineAuthorityNotLiveError(), "Studio Mac");
    expect(named?.code).toBe("machine_access_required");
    expect(named?.reason).toStartWith(
      "Machine access needed: this chat isn’t allowed to use “Studio Mac” right now.",
    );
    expect(personalMachineRefusal(new PersonalMachineAuthorityNotLiveError())?.reason).toStartWith(
      machineAccessNeededMessage(),
    );
  });

  test("admission refusals keep their own codes", () => {
    expect(
      personalMachineRefusal(
        databaseRefusal(
          "authorize_session_attempt_personal_machine",
          "42501",
          "personal machine use requires explicit grant",
        ),
        "Studio Mac",
      )?.code,
    ).toBe("personal_machine_permission_required");
    expect(
      personalMachineRefusal(
        databaseRefusal(
          "authorize_session_attempt_personal_machine",
          "42501",
          "only the personal machine owner may use it",
        ),
      )?.code,
    ).toBe("personal_machine_not_permitted");
  });

  test("any other failure stays an error", () => {
    expect(
      personalMachineRefusal(
        databaseRefusal(
          "assert_session_attempt_personal_machine",
          "23505",
          "duplicate key value violates unique constraint",
        ),
      ),
    ).toBeNull();
    expect(personalMachineRefusal(new Error("connection reset"))).toBeNull();
  });
});
