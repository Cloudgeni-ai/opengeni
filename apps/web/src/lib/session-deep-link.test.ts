import { describe, expect, test } from "bun:test";

import {
  canonicalSessionDeepLinkTarget,
  resolveAuthorizedSessionWorkspace,
  sessionDeepLinkReturnPath,
  shouldRedirectSessionDeepLink,
  type SessionReadGrant,
} from "./session-deep-link";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";

function grant(workspaceId: string, permissions: string[]): SessionReadGrant {
  return { workspaceId, permissions } as SessionReadGrant;
}

function reader(
  responses: Record<string, unknown>,
  calls: string[],
): { getSession: (workspaceId: string, sessionId: string) => Promise<unknown> } {
  return {
    async getSession(workspaceId, sessionId) {
      calls.push(`${workspaceId}/${sessionId}`);
      const response = responses[workspaceId];
      if (response instanceof Error) {
        throw response;
      }
      if (response && typeof response === "object" && "status" in response) {
        throw response;
      }
      return response ?? { id: sessionId };
    },
  };
}

describe("workspace-less session deep-link resolver", () => {
  test("redirect resolution uses only authorized session-read workspace paths", async () => {
    const calls: string[] = [];
    const result = await resolveAuthorizedSessionWorkspace(
      reader(
        {
          "workspace-a": { status: 404 },
          "workspace-b": { id: SESSION_ID },
          "workspace-c": { id: OTHER_SESSION_ID },
        },
        calls,
      ),
      [
        grant("workspace-a", ["sessions:read"]),
        grant("workspace-b", ["workspace:admin"]),
        grant("workspace-c", ["sessions:control"]),
      ],
      SESSION_ID,
    );

    expect(result).toEqual({ status: "resolved", workspaceId: "workspace-b" });
    expect(calls).toEqual([`workspace-a/${SESSION_ID}`, `workspace-b/${SESSION_ID}`]);
  });

  test("signed-out return state remains the original deep link", () => {
    expect(
      sessionDeepLinkReturnPath({
        pathname: `/sessions/${SESSION_ID}`,
        search: "?from=agent&tab=timeline",
        hash: "#latest",
      }),
    ).toBe(`/sessions/${SESSION_ID}?from=agent&tab=timeline#latest`);
  });

  test("unauthorized and cross-tenant misses stay indistinguishable", async () => {
    const calls: string[] = [];
    const result = await resolveAuthorizedSessionWorkspace(
      reader(
        {
          "workspace-a": { status: 403 },
          "workspace-b": { status: 404 },
        },
        calls,
      ),
      [grant("workspace-a", ["sessions:read"]), grant("workspace-b", ["sessions:read"])],
      SESSION_ID,
    );

    expect(result).toEqual({ status: "not-found" });
    expect(calls).toHaveLength(2);
  });

  test("nonexistent and malformed IDs do not disclose or probe", async () => {
    const nonexistentCalls: string[] = [];
    await expect(
      resolveAuthorizedSessionWorkspace(
        reader({ "workspace-a": { status: 404 } }, nonexistentCalls),
        [grant("workspace-a", ["sessions:read"])],
        OTHER_SESSION_ID,
      ),
    ).resolves.toEqual({ status: "not-found" });
    expect(nonexistentCalls).toEqual([`workspace-a/${OTHER_SESSION_ID}`]);

    const malformedCalls: string[] = [];
    await expect(
      resolveAuthorizedSessionWorkspace(
        reader({ "workspace-a": { id: SESSION_ID } }, malformedCalls),
        [grant("workspace-a", ["sessions:read"])],
        "not-a-session-id",
      ),
    ).resolves.toEqual({ status: "not-found" });
    expect(malformedCalls).toEqual([]);
  });

  test("preserves query/hash state and never redirects a canonical pathname", () => {
    const location = {
      pathname: `/sessions/${SESSION_ID}`,
      search: "?focus=queue",
      hash: "#composer",
    };
    expect(canonicalSessionDeepLinkTarget("workspace-a", SESSION_ID, location)).toBe(
      `/workspaces/workspace-a/sessions/${SESSION_ID}?focus=queue#composer`,
    );
    expect(
      shouldRedirectSessionDeepLink(
        location.pathname,
        `/workspaces/workspace-a/sessions/${SESSION_ID}`,
      ),
    ).toBe(true);
    expect(
      shouldRedirectSessionDeepLink(
        `/workspaces/workspace-a/sessions/${SESSION_ID}`,
        `/workspaces/workspace-a/sessions/${SESSION_ID}`,
      ),
    ).toBe(false);
  });

  test("surfaces non-authorization failures as a safe unavailable state", async () => {
    const result = await resolveAuthorizedSessionWorkspace(
      reader({ "workspace-a": { status: 503 } }, []),
      [grant("workspace-a", ["sessions:read"])],
      SESSION_ID,
    );

    expect(result.status).toBe("error");
  });
});
