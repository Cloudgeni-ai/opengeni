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

  test("an ended session, an unavailable server and other failures each read plainly", () => {
    expect(accountDeletionFailure(apiError(401, { error: { code: "unauthorized" } })).kind).toBe(
      "signedOut",
    );
    expect(accountDeletionFailure(apiError(503, { error: { code: "unavailable" } }))).toEqual({
      kind: "unavailable",
      message: "Account deletion isn't available yet. Try again later.",
    });
    expect(accountDeletionFailure(apiError(404, { error: { code: "not_found" } })).kind).toBe(
      "unavailable",
    );
    expect(accountDeletionFailure(apiError(400, { error: { code: "invalid" } })).kind).toBe(
      "failed",
    );
    // A 409 that isn't about owners isn't a blocker.
    expect(accountDeletionFailure(apiError(409, { error: { code: "conflict" } })).kind).toBe(
      "failed",
    );
    expect(accountDeletionFailure(new TypeError("Network request failed")).kind).toBe("failed");
  });

  test("reads and requests through the signed-in client", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    const responses = [
      new Response(JSON.stringify(preview()), { status: 200 }),
      new Response(
        JSON.stringify({
          request: {
            id: "r1",
            operationId: "op-1",
            status: "pending",
            requestedAt: "2026-11-26T00:00:00Z",
            completedAt: null,
          },
        }),
        { status: 202 },
      ),
      new Response(
        JSON.stringify({
          error: {
            code: "conflict",
            message: "Transfer ownership before deleting your account.",
            details: { code: "LAST_ORGANIZATION_OWNER", blockers: [] },
          },
        }),
        { status: 409 },
      ),
    ];
    const api = accountDeletionApi({
      fetchApi: async (input, init) => {
        calls.push({ input, ...(init ? { init } : {}) });
        return responses.shift()!;
      },
    });
    expect((await api.read()).closeOrganizations).toHaveLength(1);
    expect((await api.request("op-1")).status).toBe("pending");
    const refused = await api.request("op-1").catch((error: unknown) => error);
    expect(accountDeletionFailure(refused).kind).toBe("blocked");
    expect(calls.map((call) => [call.init?.method, call.input])).toEqual([
      ["GET", "/v1/me/account-deletion"],
      ["POST", "/v1/me/account-deletion"],
      ["POST", "/v1/me/account-deletion"],
    ]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
      confirm: "DELETE",
      operationId: "op-1",
    });
  });
});
