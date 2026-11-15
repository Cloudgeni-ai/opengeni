import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import * as db from "@opengeni/db";
import { fileOwnerContextForAgent } from "../src/domain/file-owner";
import * as sessionAuthorization from "../src/session-authorization";

const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";

const grant: AccessGrant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "worker:first-party-mcp",
  permissions: ["files:read"],
  principalKind: "agent_attempt",
  metadata: { sessionId, turnId, attemptId, executionGeneration: 1 },
};

function liveAttempt() {
  spyOn(sessionAuthorization, "requireLiveAgentAttemptAuthorization").mockResolvedValue({
    kind: "agent_attempt",
    subjectId: grant.subjectId,
    callerSessionId: sessionId,
    callerRootSessionId: sessionId,
    turnId,
    attemptId,
    executionGeneration: 1,
    initiatingHumanSubjectId: null,
  } as never);
}

afterEach(() => {
  mock.restore();
});

describe("an agent's file-owner check", () => {
  test("an attempt that goes stale after its liveness check is refused as stale", async () => {
    liveAttempt();
    const fenced = Object.assign(new Error("Failed query: SELECT knowledge_entry_read(...)"), {
      cause: { code: "42501", message: "Knowledge turn attempt is stale" },
    });
    spyOn(db, "freezeAgentLearningPolicy").mockRejectedValue(fenced);
    const error = await fileOwnerContextForAgent({ db: {} } as never, grant, "files:read").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(sessionAuthorization.SessionAuthorizationDeniedError);
    expect(error).toMatchObject({ reason: "caller_stale", cause: fenced });
  });

  test("other policy failures are not relabelled", async () => {
    liveAttempt();
    const refused = Object.assign(new Error("Failed query"), {
      cause: { code: "42501", message: "Knowledge workspace unavailable" },
    });
    spyOn(db, "freezeAgentLearningPolicy").mockRejectedValue(refused);
    await expect(fileOwnerContextForAgent({ db: {} } as never, grant, "files:read")).rejects.toBe(
      refused,
    );
  });
});
