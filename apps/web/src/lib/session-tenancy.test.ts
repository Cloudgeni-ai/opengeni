import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  classifySessionTenancyFailure,
  isCurrentSessionTenancyTarget,
  prepareSessionForkAttempt,
  prepareSessionVisibilityAttempt,
  sessionTenancyBlockerMessage,
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

  test("retains a fork key only inside the exact same-workspace source", () => {
    let generated = 0;
    const createKey = () => `operation-key-${++generated}`;
    const first = prepareSessionForkAttempt(
      null,
      { workspaceId: "workspace-a", sessionId: "session-a" },
      createKey,
    );
    expect(
      prepareSessionForkAttempt(
        first,
        { workspaceId: "workspace-a", sessionId: "session-a" },
        createKey,
      ),
    ).toBe(first);
    expect(
      prepareSessionForkAttempt(
        first,
        { workspaceId: "workspace-a", sessionId: "session-b" },
        createKey,
      ).idempotencyKey,
    ).toBe("operation-key-2");
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
    expect(sessionTenancyBlockerMessage("shared_sandbox_group")).toContain("own sandbox");

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
});
