import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as database from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import { errorCodeForStatus, httpStatusForError } from "../src/app";
import { refreshClaudeAccountUsage } from "../src/claude-subscription-account-usage";

const settings = testSettings({ claudeSubscriptionEnabled: true });
const db = {} as database.Database;
const fetchImpl: typeof fetch = async () => {
  throw new Error("A rejected credential must not dispatch a profile request");
};

function authority(
  scope: "workspace" | "organization" = "workspace",
): database.ClaudeAccountUsageAuthority {
  return {
    accountId: "fixture-account",
    workspaceId: scope === "workspace" ? "fixture-workspace" : null,
    subjectId: "user:fixture",
    credentialId: "fixture-credential",
    authoritySnapshot: { version: 1, scope },
  };
}

afterEach(() => mock.restore());

test.each(["workspace", "organization"] as const)(
  "%s account renewal unavailability is a retryable HTTP 503 with its original cause",
  async (scope) => {
    const original = new database.ClaudeSubscriptionRefreshUnavailable();
    const resolve = spyOn(database, "resolveClaudeAccountCredential").mockRejectedValue(original);
    const record = spyOn(database, "recordClaudeAccountUsage");
    const selected = authority(scope);
    let failure: unknown;
    try {
      await refreshClaudeAccountUsage(db, settings, selected, fetchImpl);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HTTPException);
    expect(httpStatusForError(failure)).toBe(503);
    expect(errorCodeForStatus(httpStatusForError(failure))).toBe("upstream_unavailable");
    expect((failure as HTTPException).cause).toBe(original);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(db, settings, selected, { fetchImpl });
    expect(record).not.toHaveBeenCalled();
  },
);

test.each([
  ["credential conflict", new database.ClaudeSubscriptionConnectionChanged()],
  ["reconnect requirement", new database.ClaudeSubscriptionReconnectRequired()],
  ["authorization denial", new HTTPException(403, { message: "Access denied" })],
  ["database failure", new Error("Database unavailable")],
  ["matching text without the domain type", new Error("Couldn't renew Claude sign-in. Try again.")],
  ["untrusted status property", { status: 503 }],
])("does not normalize %s as renewal unavailability", async (_label, original) => {
  const resolve = spyOn(database, "resolveClaudeAccountCredential").mockRejectedValue(original);
  const record = spyOn(database, "recordClaudeAccountUsage");
  const selected = authority();
  await expect(refreshClaudeAccountUsage(db, settings, selected, fetchImpl)).rejects.toBe(original);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledWith(db, settings, selected, { fetchImpl });
  expect(record).not.toHaveBeenCalled();
});
