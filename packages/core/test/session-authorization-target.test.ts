import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type {
  AccessGrant,
  Session,
  SessionAuthorizationDecision,
  SessionTurn,
} from "@opengeni/contracts";
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
let target: ReturnType<typeof spyOn<typeof database, "getSessionAuthorizationTargetProjection">>;
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
  spyOn(database, "getSlackInteractionSessionAccessForSession").mockResolvedValue(null);
  spyOn(database, "getSessionAuthorityProjection").mockResolvedValue({
    sessionId,
    rootSessionId,
    authorityEpoch: 1,
    visibility: "user_private",
    ownerSubjectId: subjectId,
    agentAccess: "workspace",
    scopeSubjectId: null,
    memoryScope: "off",
  });
  target = spyOn(database, "getSessionAuthorizationTargetProjection").mockResolvedValue({
    id: sessionId,
    accountId,
    rootSessionId,
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
  expect(target).toHaveBeenCalledWith(db, workspaceId, sessionId);
  expect(fullSession).not.toHaveBeenCalled();
});

test("a hidden target or wrong account is refused before the host is called", async () => {
  for (const row of [null, { id: sessionId, accountId: crypto.randomUUID(), rootSessionId }]) {
    target.mockResolvedValue(row);
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

test("target visibility is read again after the awaited agent actor reads", async () => {
  const callerId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Session>();
  fullSession.mockImplementation(async () => {
    entered.resolve();
    return await release.promise;
  });
  spyOn(database, "getSessionTurnForAttempt").mockResolvedValue({
    id: turnId,
    executionGeneration: 1,
    initiator: { kind: "subject", subjectId },
    initiatorContext: {},
    initiatingHumanSubjectId: subjectId,
  } as SessionTurn);
  const check = requireSessionAuthorization(
    deps,
    {
      ...grant,
      principalKind: "agent_attempt",
      metadata: { sessionId: callerId, turnId, attemptId, executionGeneration: 1 },
    },
    input,
  );
  await entered.promise;
  expect(target).not.toHaveBeenCalled();
  // The later RLS read no longer sees a target that became inaccessible.
  target.mockResolvedValue(null);
  release.resolve({
    id: callerId,
    accountId,
    rootSessionId,
    activeTurnId: turnId,
    parentSessionId: null,
    agentAccess: "workspace",
    scopeSubjectId: null,
  } as Session);
  await expect(check).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);
  expect(target).toHaveBeenCalledTimes(1);
  expect(authorizeSession).not.toHaveBeenCalled();
});

test("target read reuse stays request-scoped and stops at the handoff", async () => {
  await withSessionAuthorizationReadReuse(async (reuse) => {
    await requireSessionAuthorization(deps, grant, input);
    target.mockResolvedValue(null);
    await requireSessionAuthorization(deps, grant, input);
    expect(target).toHaveBeenCalledTimes(1);
    reuse.handOffToToolDispatch();
    await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
      SessionAuthorizationDeniedError,
    );
  });
  await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
    SessionAuthorizationDeniedError,
  );
  expect(target).toHaveBeenCalledTimes(3);
});
