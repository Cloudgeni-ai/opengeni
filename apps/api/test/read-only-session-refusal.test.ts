import { describe, expect, test } from "bun:test";
import { SessionArchivedError } from "@opengeni/db";
import { orchestrationFailureEnvelope } from "../src/mcp/server";
import {
  readOnlySessionRefusal,
  SESSION_ARCHIVED_MESSAGE,
} from "../src/routes/session-history-imports";

const guardError = (message: string) =>
  Object.assign(new Error(message), { name: "PostgresError", code: "OG002" });

describe("read-only session refusals", () => {
  test("classify the archive guard, the domain error and wrapped causes", () => {
    const archived = { code: "SESSION_ARCHIVED_READ_ONLY", message: SESSION_ARCHIVED_MESSAGE };
    expect(readOnlySessionRefusal(guardError("SESSION_ARCHIVED_READ_ONLY"))).toEqual(archived);
    expect(readOnlySessionRefusal(new SessionArchivedError())).toEqual(archived);
    expect(
      readOnlySessionRefusal(
        new Error("transaction failed", { cause: guardError("SESSION_ARCHIVED_READ_ONLY") }),
      ),
    ).toEqual(archived);
    expect(readOnlySessionRefusal(guardError("SESSION_IMPORTED_READ_ONLY"))?.code).toBe(
      "SESSION_IMPORTED_READ_ONLY",
    );
  });

  test("leave unrelated admission refusals and other errors alone", () => {
    expect(readOnlySessionRefusal(guardError("WORKSPACE_ADMISSION_CLOSED"))).toBeNull();
    expect(readOnlySessionRefusal(new Error("SESSION_ARCHIVED_READ_ONLY"))).toBeNull();
    expect(readOnlySessionRefusal(null)).toBeNull();
  });

  for (const tool of ["session_send_message", "session_steer"] as const) {
    test(`${tool} tells the calling agent the session is read-only`, () => {
      expect(orchestrationFailureEnvelope(tool, guardError("SESSION_ARCHIVED_READ_ONLY"))).toEqual({
        error: {
          code: `${tool}_session_read_only`,
          message: SESSION_ARCHIVED_MESSAGE,
          reason: "SESSION_ARCHIVED_READ_ONLY",
          retryable: false,
        },
      });
    });
  }

  test("other orchestration failures keep the generic result", () => {
    expect(orchestrationFailureEnvelope("session_send_message", new Error("boom")).error.code).toBe(
      "session_send_message_failed",
    );
  });
});
