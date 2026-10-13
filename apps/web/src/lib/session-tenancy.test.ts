import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  classifySessionTenancyFailure,
  isCurrentSessionTenancyTarget,
  prepareSessionVisibilityAttempt,
  privateSessionSandboxNote,
  retryableSessionTenancyReconciliationFailure,
  isStoppingSessionWorkError,
  normalizeSessionVisibilityWork,
  sessionTenancyBlockerMessage,
  sessionVisibilityWorkIsEmpty,
  sessionVisibilityWorkStopsWork,
  sessionVisibilityWorkSummary,
  visibilityAttemptReachedAuthoritativeState,
} from "./session-tenancy";

describe("session tenancy browser operation state", () => {
  test("retains one visibility key only for the exact workspace/session/epoch/input", () => {
    let generated = 0;
    const createKey = () => `key-${++generated}`;
    const first = prepareSessionVisibilityAttempt(
      null,
      {
        workspaceId: "workspace-a",
        sessionId: "session-a",
        visibility: "private",
        expectedAuthorityEpoch: 4,
      },
      createKey,
    );

    expect(
      prepareSessionVisibilityAttempt(
        first,
        {
          workspaceId: first.workspaceId,
          sessionId: first.sessionId,
          visibility: first.visibility,
          expectedAuthorityEpoch: first.expectedAuthorityEpoch,
        },
        createKey,
      ),
    ).toBe(first);
    expect(
      prepareSessionVisibilityAttempt(
        first,
        {
          workspaceId: first.workspaceId,
          sessionId: first.sessionId,
          visibility: first.visibility,
          expectedAuthorityEpoch: 5,
        },
        createKey,
      ).idempotencyKey,
    ).toBe("key-2");
    expect(
      prepareSessionVisibilityAttempt(
        first,
        {
          workspaceId: "workspace-b",
          sessionId: first.sessionId,
          visibility: first.visibility,
          expectedAuthorityEpoch: first.expectedAuthorityEpoch,
        },
        createKey,
      ).idempotencyKey,
    ).toBe("key-3");
  });

  test("requires both workspace and session identity for delayed outcomes", () => {
    const accepted = { workspaceId: "workspace-a", sessionId: "session-a" };
    expect(isCurrentSessionTenancyTarget(accepted, accepted)).toBe(true);
    expect(
      isCurrentSessionTenancyTarget(
        { workspaceId: "workspace-b", sessionId: "session-a" },
        accepted,
      ),
    ).toBe(false);
    expect(
      isCurrentSessionTenancyTarget(
        { workspaceId: "workspace-a", sessionId: "session-b" },
        accepted,
      ),
    ).toBe(false);
  });

  test("classifies exact quiescence blockers and authority conflicts", () => {
    const blocker = new OpenGeniApiError(
      409,
      JSON.stringify({
        error: {
          code: "conflict",
          message: "not quiescent",
          retryable: false,
          details: { reason: "not_quiescent", blocker: "active_sandbox_access" },
        },
      }),
      { mutation: true },
    );
    expect(classifySessionTenancyFailure(blocker)).toEqual({
      kind: "blocker",
      message: "Close active Files, Terminal, Desktop, and viewer access first.",
      retainAttempt: true,
      reconcile: true,
    });
    expect(sessionTenancyBlockerMessage("shared_sandbox_group")).toBe(
      "This session shares its sandbox with other sessions. Fork it into a separate session to make this change.",
    );
    // Privacy no longer requires an own sandbox: the dialog says what stays shared.
    expect(privateSessionSandboxNote("selfhosted")).toBe(
      " Files on its connected machine stay available to whoever can use that machine.",
    );
    expect(privateSessionSandboxNote("modal")).toBe(
      " Files in its sandbox stay available to other sessions that share it.",
    );
    expect(privateSessionSandboxNote("none")).toBe("");

    const epoch = new OpenGeniApiError(
      409,
      JSON.stringify({
        error: {
          code: "conflict",
          message: "epoch",
          details: { reason: "authority_epoch" },
        },
      }),
      { mutation: true },
    );
    expect(classifySessionTenancyFailure(epoch).kind).toBe("epoch_conflict");
    expect(classifySessionTenancyFailure(epoch).retainAttempt).toBe(false);
  });

  test("treats a later matching epoch as authoritative completion", () => {
    const attempt = {
      workspaceId: "workspace-a",
      sessionId: "session-a",
      visibility: "private" as const,
      expectedAuthorityEpoch: 4,
      idempotencyKey: "key",
    };
    expect(
      visibilityAttemptReachedAuthoritativeState(attempt, {
        visibility: "private",
        authorityEpoch: 5,
      }),
    ).toBe(true);
    expect(
      visibilityAttemptReachedAuthoritativeState(attempt, {
        visibility: "private",
        authorityEpoch: 4,
      }),
    ).toBe(false);
    expect(
      visibilityAttemptReachedAuthoritativeState(attempt, {
        visibility: "workspace",
        authorityEpoch: 5,
      }),
    ).toBe(false);
  });

  test("retains a settled receipt while fresh-state reconciliation is retryable", () => {
    expect(retryableSessionTenancyReconciliationFailure(new TypeError("network"))).toBe(true);
    expect(
      retryableSessionTenancyReconciliationFailure(
        new OpenGeniApiError(
          503,
          JSON.stringify({ error: { code: "unavailable", message: "retry", retryable: true } }),
        ),
      ),
    ).toBe(true);
    expect(
      retryableSessionTenancyReconciliationFailure(
        new OpenGeniApiError(
          404,
          JSON.stringify({ error: { code: "not_found", message: "gone", retryable: false } }),
        ),
      ),
    ).toBe(false);
  });

  test("summarizes the work a private change stops and classifies its conflicts", () => {
    const none = {
      runningTurnCount: 0,
      queuedTurnCount: 0,
      activeGoal: false,
      liveVoice: false,
      otherPeoplePendingUpdateCount: 0,
      otherPeopleAccountChoiceCount: 0,
    };
    expect(
      sessionVisibilityWorkSummary({
        ...none,
        runningTurnCount: 1,
        queuedTurnCount: 1,
        activeGoal: true,
        liveVoice: true,
      }),
    ).toEqual([
      "Stop the response that is in progress",
      "Cancel 1 queued message",
      "Pause the active goal",
      "End the live voice conversation",
    ]);
    const othersOnly = {
      ...none,
      otherPeoplePendingUpdateCount: 3,
      otherPeopleAccountChoiceCount: 2,
    };
    expect(sessionVisibilityWorkSummary(othersOnly)).toEqual([
      "Drop 3 pending updates that use other people's access",
      "Stop using other people's accounts in this session",
    ]);
    expect(sessionVisibilityWorkIsEmpty(none)).toBe(true);
    expect(sessionVisibilityWorkIsEmpty(othersOnly)).toBe(false);
    expect(sessionVisibilityWorkStopsWork(othersOnly)).toBe(false);
    expect(sessionVisibilityWorkStopsWork({ ...none, liveVoice: true })).toBe(true);
    // An older server reports only the first three fields.
    expect(
      normalizeSessionVisibilityWork({
        runningTurnCount: 1,
        queuedTurnCount: 0,
        activeGoal: false,
      }),
    ).toEqual({ ...none, runningTurnCount: 1 });
    expect(normalizeSessionVisibilityWork({ runningTurnCount: "1" })).toBeNull();
    const conflict = (reason: string) =>
      new OpenGeniApiError(
        409,
        JSON.stringify({
          error: {
            code: "conflict",
            message: "conflict",
            retryable: reason === "stopping_active_work",
            details: { reason, runningTurnCount: 0, queuedTurnCount: 3, activeGoal: false },
          },
        }),
      );
    expect(classifySessionTenancyFailure(conflict("active_work"))).toMatchObject({
      kind: "active_work",
      retainAttempt: true,
      reconcile: false,
      work: { runningTurnCount: 0, queuedTurnCount: 3, activeGoal: false },
    });
    expect(classifySessionTenancyFailure(conflict("stopping_active_work"))).toMatchObject({
      kind: "stopping_work",
      retainAttempt: true,
    });
    expect(isStoppingSessionWorkError(conflict("stopping_active_work"))).toBe(true);
    expect(isStoppingSessionWorkError(conflict("active_work"))).toBe(false);
  });
});
