import { describe, expect, test } from "bun:test";
import { setRlsContext, type Database } from "../src/index";

// Pure (no docker): the RLS-context hardening fails LOUD on a missing account id
// instead of letting a blank GUC silently scope every read to zero rows — the
// phantom "no active subscription" failure mode this change set targets.

describe("setRlsContext input guard", () => {
  function dbThatMustNotExecute(): Database {
    return {
      execute: async () => {
        throw new Error("db.execute must not be reached for an invalid accountId");
      },
    } as unknown as Database;
  }

  test("rejects an empty accountId before issuing any query", async () => {
    await expect(setRlsContext(dbThatMustNotExecute(), { accountId: "" })).rejects.toThrow(
      /non-empty accountId/,
    );
  });

  test("rejects a blank/whitespace accountId", async () => {
    await expect(setRlsContext(dbThatMustNotExecute(), { accountId: "   " })).rejects.toThrow(
      /non-empty accountId/,
    );
  });

  test("rejects a non-string accountId", async () => {
    await expect(
      setRlsContext(dbThatMustNotExecute(), { accountId: undefined as unknown as string }),
    ).rejects.toThrow();
  });
});
