import { describe, expect, test } from "bun:test";
import { WorkspaceArchiveStorageError } from "@opengeni/storage";
import {
  sessionArchiveFailureCode,
  sessionArchiveFailureSqlState,
} from "../src/activities/session-archive";

describe("session archive failure classification", () => {
  test("maps storage failures to reviewed, content-free codes", () => {
    const storage = (code: WorkspaceArchiveStorageError["code"]) =>
      sessionArchiveFailureCode(new WorkspaceArchiveStorageError(code, "x", false));
    expect(storage("archive_object_missing")).toBe("session_archive_object_missing");
    expect(storage("archive_hash_mismatch")).toBe("session_archive_hash_mismatch");
    expect(storage("archive_hydration_failed")).toBe("session_archive_storage_failed");
  });

  test("never echoes another error's code", () => {
    const databaseError = Object.assign(new Error("duplicate key value (secret)"), {
      code: "23505",
    });
    expect(sessionArchiveFailureCode(databaseError)).toBe("session_archive_failed");
    expect(sessionArchiveFailureCode("boom")).toBe("session_archive_failed");
  });

  test("keeps only the SQLSTATE of a database failure, even when wrapped", () => {
    const driver = Object.assign(new Error("record mismatch for (secret)"), { code: "23514" });
    const wrapped = new Error("Failed query: insert ... (secret)", { cause: driver });
    expect(sessionArchiveFailureSqlState(driver)).toBe("23514");
    expect(sessionArchiveFailureSqlState(wrapped)).toBe("23514");
    expect(sessionArchiveFailureSqlState(new Error("boom"))).toBeUndefined();
    expect(sessionArchiveFailureSqlState("boom")).toBeUndefined();
  });
});
