import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  isNewSessionDraftConflict,
  newSessionDraftConflictRevision,
} from "./use-new-session-draft";

function conflict(body: Record<string, unknown>): OpenGeniApiError {
  return new OpenGeniApiError(409, JSON.stringify(body), { mutation: true });
}

describe("new-session draft conflict revision", () => {
  test("reads the revision the server held from a draft conflict", () => {
    const error = conflict({
      code: "NEW_SESSION_DRAFT_CONFLICT",
      message: "New-session draft changed in another client",
      currentRevision: 4,
    });
    expect(isNewSessionDraftConflict(error)).toBe(true);
    expect(newSessionDraftConflictRevision(error)).toBe(4);
  });

  test("is unknown for an older server's refusal and for other errors", () => {
    expect(
      newSessionDraftConflictRevision(
        conflict({ code: "NEW_SESSION_DRAFT_CONFLICT", message: "changed" }),
      ),
    ).toBeUndefined();
    expect(
      newSessionDraftConflictRevision(conflict({ code: "OTHER", currentRevision: 4 })),
    ).toBeUndefined();
    expect(newSessionDraftConflictRevision(new Error("offline"))).toBeUndefined();
  });
});
