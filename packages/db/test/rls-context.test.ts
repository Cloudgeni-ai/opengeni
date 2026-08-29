import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
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

describe("setRlsContext query budget", () => {
  test("applies the base tenant and protocol context in one database round trip", async () => {
    let executeCalls = 0;
    let executedQuery: SQL | undefined;
    const db = {
      execute: async (query: SQL) => {
        executeCalls += 1;
        executedQuery = query;
        return [];
      },
    } as unknown as Database;

    await setRlsContext(db, {
      accountId: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
    });

    expect(executeCalls).toBe(1);
    const queryText = executedQuery?.queryChunks
      .flatMap((chunk) =>
        typeof chunk === "object" && chunk !== null && "value" in chunk
          ? (chunk.value as readonly string[])
          : [],
      )
      .join("");
    expect(queryText).toContain("set_config('opengeni.account_id'");
    expect(queryText).toContain("set_config('opengeni.workspace_id'");
    expect(queryText).toContain("set_config('opengeni.lossless_content_writer'");
    expect(queryText).toContain("set_config('opengeni.sandbox_recovery_protocol_v2'");
    expect(queryText).toContain("set_config('opengeni.pending_tool_event_output_v1'");
    expect(queryText).toContain("set_config('opengeni.session_variable_set_attachments_v1'");
  });
});
