import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  accountDeletionApi,
  accountDeletionFailure,
  canRequestDeletion,
  isDeletionConfirmed,
  retentionText,
  type AccountDeletionPreview,
} from "./account-deletion";

const preview = (patch: Partial<AccountDeletionPreview> = {}): AccountDeletionPreview => ({
  closeOrganizations: [{ organizationId: "o1", name: "Personal" }],
  leaveOrganizations: [],
  blockers: [],
  request: null,
  ...patch,
});

function apiError(status: number, body: unknown): OpenGeniApiError {
  return new OpenGeniApiError(status, JSON.stringify(body), { mutation: true });
}

describe("account deletion", () => {
  test("is confirmed only by DELETE typed in full", () => {
    expect(isDeletionConfirmed("DELETE")).toBe(true);
    expect(isDeletionConfirmed("  DELETE ")).toBe(true);
    expect(isDeletionConfirmed("delete")).toBe(false);
    expect(isDeletionConfirmed("DELET")).toBe(false);
    expect(isDeletionConfirmed("")).toBe(false);
  });

  test("can be asked for only when typed, unblocked, not underway and not already sending", () => {
    expect(canRequestDeletion({ preview: preview(), typed: "DELETE", submitting: false })).toBe(
      true,
    );
    expect(canRequestDeletion({ preview: preview(), typed: "DELETE", submitting: true })).toBe(
      false,
    );
    expect(
      canRequestDeletion({
        preview: preview({
          blockers: [{ code: "LAST_ORGANIZATION_OWNER", organizationId: "o2", name: "Acme" }],
        }),
        typed: "DELETE",
        submitting: false,
      }),
    ).toBe(false);
    expect(
      canRequestDeletion({
        preview: preview({
          request: {
            id: "r",
            operationId: "op",
            status: "running",
            requestedAt: "2026-11-26T00:00:00Z",
            completedAt: null,
          },
        }),
        typed: "DELETE",
        submitting: false,
      }),
    ).toBe(false);
  });

  test("says what stays and what goes in an organization you leave", () => {
    expect(retentionText({ mode: "retain", days: null })).toBe(
      "Your personal workspace there is kept",
    );
    expect(retentionText({ mode: "delete_after", days: 30 })).toBe(
      "Your personal workspace there is deleted after 30 days",
    );
    expect(retentionText({ mode: "delete_after", days: 1 })).toBe(
      "Your personal workspace there is deleted after 1 day",
    );
    expect(retentionText({ mode: "delete_after", days: null })).toBe(
      "Your personal workspace there is deleted later",
    );
  });

  test("a last-owner refusal brings the server's blockers", () => {
    const failure = accountDeletionFailure(
      apiError(409, {
        error: {
          code: "conflict",
          message: "Transfer ownership before deleting your account.",
          details: {
            code: "LAST_ORGANIZATION_OWNER",
            blockers: [
              { code: "LAST_ORGANIZATION_OWNER", organizationId: "o2", name: "Acme" },
              { nonsense: true },
            ],
          },
        },
      }),
    );
    expect(failure).toEqual({
      kind: "blocked",
      message: "Transfer ownership before deleting your account.",
      blockers: [{ code: "LAST_ORGANIZATION_OWNER", organizationId: "o2", name: "Acme" }],
    });
  });

  test("an ended session, a busy account, an unavailable server and other failures each read plainly", () => {
    expect(accountDeletionFailure(apiError(401, { error: { code: "unauthorized" } })).kind).toBe(
      "signedOut",
    );
    expect(
      accountDeletionFailure(
        apiError(409, {
          error: {
            code: "conflict",
            message: "Your account is busy. Wait a moment and try again.",
            details: { code: "ACCOUNT_DELETION_BUSY" },
          },
        }),
      ),
    ).toEqual({ kind: "busy", message: "Your account is busy. Wait a moment and try again." });
    expect(
      accountDeletionFailure(
        apiError(503, {
          error: {
            code: "upstream_unavailable",
            message: "Account deletion is not available yet.",
            details: { code: "ACCOUNT_DELETION_UNAVAILABLE" },
          },
        }),
      ),
    ).toEqual({
      kind: "unavailable",
      message: "Account deletion isn't available yet. Try again later.",
    });
    expect(accountDeletionFailure(apiError(404, { error: { code: "not_found" } })).kind).toBe(
      "unavailable",
    );
    expect(accountDeletionFailure(apiError(400, { error: { code: "invalid" } })).kind).toBe(
      "failed",
    );
    // A 409 that isn't about owners or a busy account isn't a blocker.
    expect(accountDeletionFailure(apiError(409, { error: { code: "conflict" } })).kind).toBe(
      "failed",
    );
    expect(accountDeletionFailure(new TypeError("Network request failed")).kind).toBe("failed");
  });

  test("a request that got no answer stays apart from one that was accepted", () => {
    const lost = new OpenGeniApiError(0, "", {
      code: "network_error",
      outcomeUnknown: true,
      mutation: true,
    });
    expect(accountDeletionFailure(lost).kind).toBe("unconfirmed");
    // Starting deletion signs every device out, so a 401 on the retry most likely means it started.
    const after = accountDeletionFailure(apiError(401, { error: { code: "unauthorized" } }), {
      afterUnconfirmed: true,
    });
    expect(after.kind).toBe("signedOut");
    expect(after.message).toContain("we'll email you when it's complete");
  });

  test("reads and requests through the signed-in client", async () => {
    const calls: unknown[] = [];
    const receipt = {
      id: "r1",
      operationId: "op-1",
      status: "pending" as const,
      requestedAt: "2026-11-26T00:00:00Z",
      completedAt: null,
    };
    const api = accountDeletionApi({
      getAccountDeletion: async () => {
        calls.push("get");
        return preview();
      },
      requestAccountDeletion: async (input) => {
        calls.push(input);
        return { request: receipt };
      },
    });
    expect((await api.read()).closeOrganizations).toHaveLength(1);
    expect(await api.request("op-1")).toEqual(receipt);
    expect(calls).toEqual(["get", { confirm: "DELETE", operationId: "op-1" }]);
  });
});
