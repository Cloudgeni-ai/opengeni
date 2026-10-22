import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { AccessGrant, SessionAuthorizationDecision } from "@opengeni/contracts";
import * as database from "@opengeni/db";
import {
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  withSessionAuthorizationReadReuse,
} from "../src/session-authorization";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const rootSessionId = crypto.randomUUID();
const subjectId = "user:reader";
const db = {} as database.Database;
const grant: AccessGrant = {
  accountId,
  workspaceId,
  subjectId,
  principalKind: "human_session",
  permissions: ["sessions:read"],
};
const input = { sessionId, operation: "session.read", surface: "http" } as const;

function targetFacts(
  overrides: Partial<NonNullable<database.SessionAuthorizationFacts["target"]>> = {},
): NonNullable<database.SessionAuthorizationFacts["target"]> {
  return {
    sessionId,
    accountId,
    rootSessionId,
    authorityEpoch: 1,
    visibility: "user_private",
    ownerSubjectId: subjectId,
    siteId: null,
    siteAccessRootId: null,
    siteViewerPrincipal: null,
    siteOwnerSubjectId: null,
    agentAccess: "workspace",
    scopeSubjectId: null,
    memoryScope: "off",
    slackAccess: null,
    ...overrides,
  };
}

let facts: ReturnType<typeof spyOn<typeof database, "getSessionAuthorizationFacts">>;
let fullSession: ReturnType<typeof spyOn<typeof database, "getSession">>;
const authorizeSession = mock(
  async (): Promise<SessionAuthorizationDecision> => ({ allowed: true }),
);
const deps = {
  db,
  sessionAuthorization: {
    authorizeSession,
    resolveListScope: async () => ({ kind: "all" as const }),
  },
};

beforeEach(() => {
  authorizeSession.mockReset();
  authorizeSession.mockResolvedValue({ allowed: true });
  facts = spyOn(database, "getSessionAuthorizationFacts").mockResolvedValue({
    target: targetFacts(),
    caller: null,
  });
  fullSession = spyOn(database, "getSession").mockRejectedValue(
    new Error("Target authorization must not expand the full chat"),
  );
});
afterEach(() => mock.restore());

test("target authorization passes durable identity to the host without expanding the chat", async () => {
  const result = await requireSessionAuthorization(deps, grant, input);
  expect(result?.target).toEqual({ sessionId, rootSessionId });
  expect(authorizeSession).toHaveBeenCalledWith(
    expect.objectContaining({ accountId, workspaceId, target: { sessionId, rootSessionId } }),
  );
  expect(facts).toHaveBeenCalledTimes(1);
  expect(facts).toHaveBeenCalledWith(db, { accountId, workspaceId, sessionId, caller: undefined });
  expect(fullSession).not.toHaveBeenCalled();
});

test("a hidden target or wrong account is refused before the host is called", async () => {
  for (const target of [null, targetFacts({ accountId: crypto.randomUUID() })]) {
    facts.mockResolvedValue({ target, caller: null });
    await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
      SessionAuthorizationDeniedError,
    );
  }
  expect(authorizeSession).not.toHaveBeenCalled();
});

test("host denial and host failure still refuse the request", async () => {
  authorizeSession.mockResolvedValue({ allowed: false, reason: "forbidden" });
  await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
    SessionAuthorizationDeniedError,
  );
  authorizeSession.mockRejectedValue(new Error("host unavailable"));
  await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
    SessionAuthorizationUnavailableError,
  );
});

test("an agent attempt's caller and target come from the same single read", async () => {
  // The browser and computer routes authorize an agent acting on its own session.
  const callerId = sessionId;
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const agentGrant: AccessGrant = {
    ...grant,
    principalKind: "agent_attempt",
    metadata: { sessionId: callerId, turnId, attemptId, executionGeneration: 1 },
  };
  const caller: database.SessionAuthorizationFacts["caller"] = {
    session: {
      accountId,
      rootSessionId,
      parentSessionId: null,
      agentAccess: "workspace",
      scopeSubjectId: null,
    },
    turn: {
      id: turnId,
      executionGeneration: 1,
      initiator: { kind: "subject", subjectId },
      initiatorContext: {},
      initiatingHumanSubjectId: subjectId,
    },
  };
  facts.mockResolvedValue({ target: targetFacts(), caller });
  const result = await requireSessionAuthorization(deps, agentGrant, input);
  expect(result?.actor).toMatchObject({ kind: "agent_attempt", callerSessionId: callerId });
  expect(facts).toHaveBeenCalledTimes(1);
  expect(facts).toHaveBeenCalledWith(db, {
    accountId,
    workspaceId,
    sessionId,
    caller: { sessionId: callerId, attemptId },
  });

  // A target the caller cannot see is not found, whatever the caller's state.
  facts.mockResolvedValue({ target: null, caller });
  await expect(requireSessionAuthorization(deps, agentGrant, input)).rejects.toMatchObject({
    reason: "not_found",
  });
  // A turn that is no longer live, or a different generation, is stale.
  for (const stale of [
    { ...caller, turn: null },
    { ...caller, turn: { ...caller.turn!, executionGeneration: 2 } },
    { ...caller, session: { ...caller.session!, accountId: crypto.randomUUID() } },
  ]) {
    facts.mockResolvedValue({ target: targetFacts(), caller: stale });
    await expect(requireSessionAuthorization(deps, agentGrant, input)).rejects.toMatchObject({
      reason: "caller_stale",
    });
  }
  expect(fullSession).not.toHaveBeenCalled();
});

test("read reuse stays request-scoped and stops at the handoff", async () => {
  await withSessionAuthorizationReadReuse(async (reuse) => {
    await requireSessionAuthorization(deps, grant, input);
    facts.mockResolvedValue({ target: null, caller: null });
    await requireSessionAuthorization(deps, grant, input);
    expect(facts).toHaveBeenCalledTimes(1);
    reuse.handOffToToolDispatch();
    await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
      SessionAuthorizationDeniedError,
    );
  });
  await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
    SessionAuthorizationDeniedError,
  );
  expect(facts).toHaveBeenCalledTimes(3);
});
