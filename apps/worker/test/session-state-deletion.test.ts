import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const input = { workspaceId: "workspace", sessionId: "session", observerAccountId: "account" };
const services = async () => ({ db: {}, bus: {}, settings: {}, observability: {} }) as any;

describe("deleted session control activities", () => {
  for (const activityName of ["recoverDispatch", "settleSessionInputWait"] as const) {
    test.each(["deleted", "live", "hidden", "unavailable"] as const)(
      `${activityName} only returns stale after deletion proof (%s)`,
      async (state) => {
        const activityFailure = new Error("Control activity database lookup failed");
        const proofFailure = new Error("Deletion proof database unavailable");
        const failed = mock(async () => {
          throw activityFailure;
        });
        const proof = mock(async () => {
          if (state === "unavailable") throw proofFailure;
          return state === "deleted";
        });
        const publish = mock(async () => undefined);
        const notify = mock(async () => undefined);
        const metrics = mock(() => undefined);
        const activities = createSessionStateActivities(services, {
          recoverSessionDispatch: failed,
          settleSessionInputWait: failed,
          isSessionDefinitivelyDeleted: proof,
          publishDurableSessionEvents: publish,
          deliverFailedChildTurnToParent: notify,
          recordWorkerDeathRecoveryMetrics: metrics,
        });
        const result = activities[activityName]({
          ...input,
          accountId: "account",
          attemptId: "attempt",
          timeoutType: "HEARTBEAT",
          waitTurnId: "wait-turn",
          disposition: "timeout",
        });
        if (state === "deleted") await expect(result).resolves.toEqual({ action: "stale" });
        else
          await expect(result).rejects.toBe(
            state === "unavailable" ? proofFailure : activityFailure,
          );
        expect(proof).toHaveBeenCalledWith(expect.anything(), "workspace", "session", "account");
        expect(publish).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(metrics).not.toHaveBeenCalled();
      },
    );
  }

  test.each([true, false])(
    "late interruption and proof activities tolerate only deletion (%s)",
    async (deleted) => {
      const failed = async () => {
        throw new Error("Session not found");
      };
      const activities = createSessionStateActivities(services, {
        settleSessionAttemptInterruptions: failed,
        markSessionAttemptQuiesced: failed,
        isSessionDefinitivelyDeleted: mock(async () => deleted),
      });
      const proof = {
        ...input,
        accountId: "account",
        attemptId: "attempt",
        workflowId: "workflow",
        workflowRunId: "run",
        activityId: "activity",
      };
      if (deleted) {
        await expect(activities.settleSessionInterruptions(proof)).resolves.toEqual({
          action: "stale",
        });
        await expect(activities.persistSessionAttemptQuiescence(proof)).resolves.toBeUndefined();
      } else {
        await expect(activities.settleSessionInterruptions(proof)).rejects.toThrow(
          "Session not found",
        );
        await expect(activities.persistSessionAttemptQuiescence(proof)).rejects.toThrow(
          "Session not found",
        );
      }
    },
  );
  test.each([true, false])(
    "only patch-aware peeks report proven deletion (%s)",
    async (patched) => {
      const proof = mock(async () => true);
      const activities = createSessionStateActivities(services, {
        peekSessionWork: mock(async () => ({ kind: "unavailable" as const })),
        isSessionDefinitivelyDeleted: proof,
      });
      expect(await activities.peekSessionWork({ ...input, includeDeletion: patched })).toEqual({
        kind: patched ? "deleted" : "unavailable",
      });
      expect(proof).toHaveBeenCalledTimes(patched ? 1 : 0);
    },
  );

  test("a missing workspace closes only patch-aware histories", async () => {
    const activities = createSessionStateActivities(services, {
      getWorkspace: mock(async () => null),
      isSessionDefinitivelyDeleted: mock(async () => true),
    });
    const legacy = { workspaceId: input.workspaceId, sessionId: input.sessionId };
    expect(await activities.peekSessionWork(legacy)).toEqual({ kind: "unavailable" });
    expect(await activities.peekSessionWork({ ...legacy, includeDeletion: true })).toEqual({
      kind: "deleted",
    });
  });

  test("hidden rows stay unavailable and database errors propagate", async () => {
    const proof = mock(async () => false);
    const activities = createSessionStateActivities(services, {
      peekSessionWork: mock(async () => ({ kind: "unavailable" as const })),
      isSessionDefinitivelyDeleted: proof,
    });
    expect(await activities.peekSessionWork({ ...input, includeDeletion: true })).toEqual({
      kind: "unavailable",
    });
    proof.mockImplementation(async () => {
      throw new Error("database offline");
    });
    await expect(activities.peekSessionWork({ ...input, includeDeletion: true })).rejects.toThrow(
      "database offline",
    );
  });

  test.each([true, false])(
    "idle settlement tolerates deletion, not unavailability (%s)",
    async (deleted) => {
      const notify = mock(async () => undefined);
      const publish = mock(async () => undefined);
      const activities = createSessionStateActivities(services, {
        settleSessionIdleWithParentOutbox: mock(async () => {
          throw new Error("Session not found");
        }),
        isSessionDefinitivelyDeleted: mock(async () => deleted),
        notifyParentOfChildIdle: notify as any,
        publishDurableSessionEvents: publish,
      });
      if (deleted) await expect(activities.markSessionIdle(input)).resolves.toBeUndefined();
      else await expect(activities.markSessionIdle(input)).rejects.toThrow("Session not found");
      expect(notify).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  test.each([true, false])(
    "failure settlement tolerates only definitive deletion (%s)",
    async (deleted) => {
      const activities = createSessionStateActivities(services, {
        requireSession: mock(async () => {
          throw new Error("Session not found");
        }),
        isSessionDefinitivelyDeleted: mock(async () => deleted),
      });
      const failure = { ...input, accountId: "account", attemptId: "attempt" };
      if (deleted)
        await expect(activities.failSessionAttempt(failure)).resolves.toEqual({
          action: "terminal",
        });
      else
        await expect(activities.failSessionAttempt(failure)).rejects.toThrow("Session not found");
    },
  );
});
