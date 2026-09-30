import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import * as authorization from "../src/session-authorization";
import {
  sendAgentSessionMessage,
  steerAgentSession,
  type AgentSessionCommandContext,
} from "../src/application/session-commands";

const context: AgentSessionCommandContext = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "agent:request-subject",
  callerSessionId: "33333333-3333-4333-8333-333333333333",
  callerTurnId: "44444444-4444-4444-8444-444444444444",
  callerAttemptId: "55555555-5555-4555-8555-555555555555",
  callerExecutionGeneration: 3,
};
const targetSessionId = "66666666-6666-4666-8666-666666666666";
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function fixture(action: "send" | "steer", replay = false) {
  const tx = {} as db.SessionActivityDatabase;
  track(spyOn(authorization, "requireSessionAuthorization").mockResolvedValue(null));
  track(
    spyOn(db, "withWorkspaceSessionActivityRls").mockImplementation(
      async (_db, _workspace, fn) => await fn(tx),
    ),
  );
  const target = track(
    spyOn(db, "getSession").mockResolvedValue({
      id: targetSessionId,
      accountId: context.accountId,
      model: "scripted-model",
      createdBy: { kind: "subject", subjectId: "user:target-creator" },
    } as never),
  );
  const frozen = track(
    spyOn(db, "frozenInitiatorForCommandActor").mockResolvedValue({
      initiator: { kind: "service", subjectId: "worker:causal-agent" },
      context: {},
      initiatingHumanSubjectId: "user:frozen-human",
    }),
  );
  const allowance = track(spyOn(db, "checkWorkspaceAllowance").mockResolvedValue(null));
  const codex = track(spyOn(db, "isCodexBilledTurn").mockResolvedValue(false));
  const result = {
    replay,
    eventIds: [],
    workspaceControlEventId: null,
    updateId: "update",
    receipt: { id: "receipt" },
  } as never;
  const command = track(
    spyOn(
      db,
      action === "send" ? "sendAgentMessageInTransaction" : "steerAgentSessionInTransaction",
    ).mockImplementation(async (_tx, input) => {
      if (!replay) await input.assertFreshAdmission?.(tx);
      return result;
    }),
  );
  const deps = {
    db: tx,
    settings: testSettings(),
    bus: {} as never,
    workflowClient: { wakeSessionWorkflow: async () => undefined },
    schedulePromptPostCommit: () => undefined,
  };
  const run = () =>
    action === "send"
      ? sendAgentSessionMessage(deps, context, {
          targetSessionId,
          text: "Send",
          idempotencyKey: "operation",
        })
      : steerAgentSession(deps, context, {
          targetSessionId,
          instruction: "Steer",
          idempotencyKey: "operation",
        });
  return { tx, target, frozen, allowance, codex, command, deps, run };
}

describe("agent command fresh allowance callbacks", () => {
  for (const action of ["send", "steer"] as const) {
    test(`${action} checks the exact frozen initiating human, not creator or request subject`, async () => {
      const f = fixture(action);
      const refusal = {
        code: "allowance_exhausted" as const,
        scope: "member" as const,
        subjectId: "user:frozen-human",
        resetsAt: "2026-10-01T00:00:00.000Z",
        message: "Member usage exhausted",
      };
      f.allowance.mockResolvedValue(refusal);
      await expect(f.run()).rejects.toMatchObject({
        status: 402,
        cause: { allowed: false, ...refusal },
      });
      expect(f.frozen).toHaveBeenCalledWith(f.tx, context.workspaceId, {
        type: "agent_attempt",
        sessionId: context.callerSessionId,
        turnId: context.callerTurnId,
        attemptId: context.callerAttemptId,
        executionGeneration: context.callerExecutionGeneration,
      });
      expect(f.allowance).toHaveBeenCalledWith(f.tx, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        subjectId: "user:frozen-human",
      });
    });
    test.each([null, "api_key:legacy-service"])(
      `${action} uses workspace-only policy for service attribution %s`,
      async (subjectId) => {
        const f = fixture(action);
        f.frozen.mockResolvedValue({
          initiator: { kind: "service", subjectId: "service:work" },
          context: {},
          initiatingHumanSubjectId: subjectId,
        });
        await f.run();
        expect(f.allowance).toHaveBeenCalledWith(f.tx, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          subjectId: null,
        });
      },
    );
    test(`${action} exact replay never consults mutable funding, target or allowance`, async () => {
      const f = fixture(action, true);
      expect((await f.run()).replay).toBe(true);
      expect(f.target).not.toHaveBeenCalled();
      expect(f.frozen).not.toHaveBeenCalled();
      expect(f.codex).not.toHaveBeenCalled();
      expect(f.allowance).not.toHaveBeenCalled();
    });
    test(`${action} externally billed Codex target bypasses allowance checks`, async () => {
      const f = fixture(action);
      f.codex.mockResolvedValue(true);
      await f.run();
      expect(f.allowance).not.toHaveBeenCalled();
    });
  }
});
