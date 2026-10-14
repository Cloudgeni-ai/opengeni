import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  SessionUsageLimitHttpError,
  sessionUsageLimitWriteActorForAccess,
  stampDelegatedHumanAuthorization,
  type AccessGrantAuthorization,
} from "../src";

// only a person present in the app or the host's server key may
// change a task usage limit. principalKind alone is never proof of a person.
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";

function access(
  grant: Partial<AccessGrant>,
  overrides: Partial<AccessGrantAuthorization> = {},
): AccessGrantAuthorization {
  const full: AccessGrant = {
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    subjectId: "user:alice",
    permissions: ["sessions:read", "sessions:control"],
    ...grant,
  };
  return {
    grant: full,
    accountGrant: null,
    authenticatedSubjectId: full.subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: false,
    canonicalLocalHumanSession: false,
    ...overrides,
  };
}

function forbidden(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionUsageLimitHttpError);
    expect((error as SessionUsageLimitHttpError).status).toBe(403);
    expect((error as SessionUsageLimitHttpError).code).toBe("session_usage_limit_forbidden");
    return;
  }
  throw new Error("expected the write to be forbidden");
}

describe("session usage limit write actor", () => {
  test("a person signed in to the app and the host's server key may write", () => {
    expect(
      sessionUsageLimitWriteActorForAccess(
        access({ principalKind: "human_session" }, { canonicalManagedHumanSession: true }),
      ),
    ).toEqual({ type: "human", subjectId: "user:alice" });
    expect(
      sessionUsageLimitWriteActorForAccess(
        access({ principalKind: "api_key", subjectId: "api-key:host" }),
      ),
    ).toEqual({ type: "host", subjectId: "api-key:host" });
    expect(
      sessionUsageLimitWriteActorForAccess(
        access({ principalKind: "configured_key", subjectId: "configured:host" }),
      ),
    ).toEqual({ type: "host", subjectId: "configured:host" });
  });

  test("agents, session bearers, services and unverified contexts are refused", () => {
    // A live agent attempt, whatever principal it claims.
    for (const metadata of [{ attemptId: "a" }, { turnId: "t" }, { sessionId: "s" }]) {
      forbidden(() =>
        sessionUsageLimitWriteActorForAccess(access({ principalKind: "human_session", metadata })),
      );
      forbidden(() =>
        sessionUsageLimitWriteActorForAccess(access({ principalKind: "api_key", metadata })),
      );
    }
    forbidden(() =>
      sessionUsageLimitWriteActorForAccess(access({ principalKind: "agent_attempt" })),
    );
    forbidden(() => sessionUsageLimitWriteActorForAccess(access({ principalKind: "service" })));
    forbidden(() => sessionUsageLimitWriteActorForAccess(access({})));
    // A person-shaped principal without context integrity, or acting for a service.
    forbidden(() =>
      sessionUsageLimitWriteActorForAccess(
        access({ principalKind: "human_session" }, { contextIntegrity: false }),
      ),
    );
    forbidden(() =>
      sessionUsageLimitWriteActorForAccess(
        access({ principalKind: "human_session" }, { authenticatedSubjectId: "user:mallory" }),
      ),
    );
    forbidden(() =>
      sessionUsageLimitWriteActorForAccess(
        access({
          principalKind: "human_session",
          serviceInitiator: { kind: "service", subjectId: "scheduler" } as never,
        }),
      ),
    );
    forbidden(() =>
      sessionUsageLimitWriteActorForAccess(
        access({ principalKind: "api_key" }, { contextIntegrity: false }),
      ),
    );
  });

  test("an agent acting for a person is refused even with full access", () => {
    // Organization MCP dispatch, session admin access and personal API keys
    // all stamp the request with a verified delegated-human proof.
    const request = new Request("http://opengeni.test/v1/x", { method: "PUT" });
    stampDelegatedHumanAuthorization(request, {
      organizationId: ACCOUNT,
      subjectId: "user:alice",
      permissions: ["account:admin", "workspace:admin", "sessions:control"] as never,
      workspaceScope: { kind: "all" },
    });
    forbidden(() =>
      sessionUsageLimitWriteActorForAccess(
        access({ principalKind: "human_session" }, { canonicalManagedHumanSession: false }),
        request,
      ),
    );
    forbidden(() =>
      sessionUsageLimitWriteActorForAccess(access({ principalKind: "api_key" }), request),
    );
  });
});
