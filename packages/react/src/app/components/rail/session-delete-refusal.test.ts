import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { isStillRunningDeleteRefusal } from "./session-list";

function refusal(code: string, message: string) {
  return new OpenGeniApiError(
    409,
    JSON.stringify({
      error: { status: 409, code: "conflict", message, retryable: false, details: { code } },
    }),
  );
}

describe("isStillRunningDeleteRefusal", () => {
  test("stops and retries only while the chat is running or its box is shutting down", () => {
    expect(
      isStillRunningDeleteRefusal(
        refusal("session_delete_active_sessions", "This chat is still running."),
      ),
    ).toBe(true);
    expect(
      isStillRunningDeleteRefusal(refusal("session_delete_live_sandboxes", "still shutting down")),
    ).toBe(true);
  });

  test("never cancels a chat for a permanent refusal", () => {
    expect(
      isStillRunningDeleteRefusal(
        refusal(
          "session_delete_externally_referenced",
          "This chat has saved workspace outputs or forks that depend on it. Archive it instead.",
        ),
      ),
    ).toBe(false);
    expect(
      isStillRunningDeleteRefusal(
        refusal("session_delete_not_root", "Delete the chat this one belongs to"),
      ),
    ).toBe(false);
    expect(
      isStillRunningDeleteRefusal(
        refusal(
          "session_delete_active_background_commands",
          "Stop this chat's background commands",
        ),
      ),
    ).toBe(false);
  });

  test("older servers without codes: only the running message retries", () => {
    const legacy = (message: string) =>
      new OpenGeniApiError(409, JSON.stringify({ error: { status: 409, message } }));
    expect(
      isStillRunningDeleteRefusal(legacy("This chat is still running. Stop it, then delete it.")),
    ).toBe(true);
    expect(
      isStillRunningDeleteRefusal(
        legacy(
          "This chat has saved workspace outputs or forks that depend on it. Archive it instead.",
        ),
      ),
    ).toBe(false);
  });
});
