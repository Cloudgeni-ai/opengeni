import { describe, expect, test } from "bun:test";
import type { DurableLearningAttemptReceipt } from "@opengeni/contracts";
import type {
  Database,
  DurableLearningAttemptAdmission,
  DurableLearningAuthorityResult,
} from "@opengeni/db";
import {
  DurableLearningAuthorityWriteError,
  DurableLearningRollbackUnavailableError,
  createDurableLearningRouter,
  type DurableLearningAuthorityAdapter,
  type DurableLearningRouterOptions,
} from "../src/domain/durable-learning-router";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000101";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000102";
const SESSION_ID = "00000000-0000-4000-8000-000000000103";
const TURN_ID = "00000000-0000-4000-8000-000000000104";
const EXECUTION_ATTEMPT_ID = "00000000-0000-4000-8000-000000000105";
const RESOURCE_ID = "00000000-0000-4000-8000-000000000106";
const TARGET_ATTEMPT_ID = "00000000-0000-4000-8000-000000000107";
const NOW = "2026-08-10T00:00:00.000Z";

const authority = {
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  attemptId: EXECUTION_ATTEMPT_ID,
  executionGeneration: 1,
};

type Run = NonNullable<DurableLearningRouterOptions["ledger"]>["run"];
type Get = NonNullable<DurableLearningRouterOptions["ledger"]>["get"];

function receipt(
  admission: DurableLearningAttemptAdmission,
  result: DurableLearningAuthorityResult,
): DurableLearningAttemptReceipt {
  return {
    attemptId: admission.id,
    inputHash: admission.inputHash,
    operation: admission.request.operation,
    ...result,
    createdAt: NOW,
  };
}

function ledger(input?: {
  get?: Get;
  onRun?: (admission: DurableLearningAttemptAdmission) => void;
}) {
  const run: Run = async (_db, request, apply) => {
    const admission: DurableLearningAttemptAdmission = {
      id: request.operationId,
      inputHash: "a".repeat(64),
      initiatingHumanSubjectId: "human:initiator",
      authority: request.authority,
      request: request.request,
      decision: request.decision,
    };
    input?.onRun?.(admission);
    return receipt(admission, await apply({} as Database, admission));
  };
  const get: Get =
    input?.get ??
    (async () => {
      return null;
    });
  return { run, get };
}

function adapter(input: {
  write?: DurableLearningAuthorityAdapter["write"];
  rollback?: DurableLearningAuthorityAdapter["rollback"];
}): DurableLearningAuthorityAdapter {
  return {
    write:
      input.write ??
      (async () => ({
        outcome: "applied",
        resource: {
          surface: "company_profile",
          id: RESOURCE_ID,
          version: "1",
          status: "active",
        },
        effectiveBoundary: "next_accepted_attempt",
        rollback: { supported: false, targetAttemptId: null, token: null },
      })),
    rollback:
      input.rollback ??
      (async () => ({
        resource: {
          surface: "company_profile",
          id: RESOURCE_ID,
          version: "2",
          status: "active",
        },
        effectiveBoundary: "next_accepted_attempt",
      })),
  };
}

describe("durable-learning router", () => {
  test("maps each canonical subject to exactly one scoped authority", async () => {
    const routed: Array<{ destination: string; input: Record<string, unknown> }> = [];
    const factory = (destination: string) => () =>
      adapter({
        async write(raw) {
          routed.push({ destination, input: raw as Record<string, unknown> });
          return {
            outcome: "applied",
            resource: {
              surface: destination as
                | "company_profile"
                | "workspace_instruction_policy"
                | "preference_registry",
              id: RESOURCE_ID,
              version: "1",
              status: "active",
            },
            effectiveBoundary: "next_accepted_attempt",
            rollback: { supported: false, targetAttemptId: null, token: null },
          };
        },
      });
    const router = createDurableLearningRouter({
      db: {} as Database,
      ledger: ledger(),
      authorities: {
        company_profile: factory("company_profile"),
        workspace_instruction_policy: factory("workspace_instruction_policy"),
        preference_registry: factory("preference_registry"),
      },
    });

    await router.write({
      operationId: "00000000-0000-4000-8000-000000000111",
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "company_goal",
        stableKey: "safe-writes",
        content: "Keep durable writes safe.",
      },
    });
    await router.write({
      operationId: "00000000-0000-4000-8000-000000000112",
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "workspace_instruction",
        target: { kind: "policy", scope: "global", roleKey: null },
        content: "Require confirmation before durable writes.",
      },
    });
    await router.write({
      operationId: "00000000-0000-4000-8000-000000000113",
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "preference",
        action: "create",
        scope: "user",
        stableKey: "concise-updates",
        title: "Concise updates",
        description: "Keep routine updates concise.",
        content: "Prefer concise routine updates.",
      },
    });

    expect(routed.map(({ destination }) => destination)).toEqual([
      "company_profile",
      "workspace_instruction_policy",
      "preference_registry",
    ]);
    expect(routed.map(({ input }) => input.decision)).toEqual([
      {
        disposition: "route",
        destination: "company_profile",
        scope: { kind: "organization" },
        authority: "active",
      },
      {
        disposition: "route",
        destination: "workspace_instruction_policy",
        scope: { kind: "workspace" },
        authority: "active",
      },
      {
        disposition: "route",
        destination: "preference_registry",
        scope: { kind: "user" },
        authority: "active",
      },
    ]);
    for (const { input } of routed) {
      expect(input.attempt).toMatchObject({
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        actor: { kind: "agent", subjectId: "human:initiator" },
      });
    }
  });

  test("rejects unconfirmed input before ledger admission", async () => {
    let runs = 0;
    const router = createDurableLearningRouter({
      db: {} as Database,
      ledger: ledger({ onRun: () => runs++ }),
    });
    await expect(
      router.write({
        operationId: "00000000-0000-4000-8000-000000000121",
        authority,
        activation: "active",
        subject: {
          kind: "company_goal",
          stableKey: "unconfirmed",
          content: "This must not be persisted.",
        },
      }),
    ).rejects.toThrow();
    expect(runs).toBe(0);
  });

  test("keeps authority failures typed and destination-specific", async () => {
    const source = new Error("destination failed");
    const router = createDurableLearningRouter({
      db: {} as Database,
      ledger: ledger(),
      authorities: {
        company_profile: () =>
          adapter({
            async write() {
              throw source;
            },
          }),
      },
    });
    const failure = router.write({
      operationId: "00000000-0000-4000-8000-000000000122",
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "company_goal",
        stableKey: "typed-failures",
        content: "Keep failures typed.",
      },
    });
    await expect(failure).rejects.toBeInstanceOf(DurableLearningAuthorityWriteError);
    await expect(failure).rejects.toMatchObject({
      code: "AUTHORITY_WRITE_FAILED",
      destination: "company_profile",
      cause: source,
    });
  });

  test("rolls back only the immutable target receipt and preserves its initiating human", async () => {
    const token = "preference-registry.v1:rollback-token";
    const targetReceipt: DurableLearningAttemptReceipt = {
      attemptId: TARGET_ATTEMPT_ID,
      inputHash: "b".repeat(64),
      operation: "write",
      outcome: "applied",
      resource: {
        surface: "preference_registry",
        id: RESOURCE_ID,
        version: "2:1",
        status: "active",
      },
      effectiveBoundary: "next_accepted_attempt",
      rollback: { supported: true, targetAttemptId: null, token },
      createdAt: NOW,
    };
    let captured: Record<string, unknown> | null = null;
    const router = createDurableLearningRouter({
      db: {} as Database,
      ledger: ledger({
        get: async () => ({
          initiatingHumanSubjectId: "human:target-initiator",
          decision: {
            disposition: "route",
            destination: "preference_registry",
            scope: { kind: "user" },
            authority: "active",
          },
          receipt: targetReceipt,
        }),
      }),
      authorities: {
        preference_registry: () =>
          adapter({
            async rollback(raw) {
              captured = raw as Record<string, unknown>;
              return {
                resource: {
                  surface: "preference_registry",
                  id: RESOURCE_ID,
                  version: "3",
                  status: "proposed",
                },
                effectiveBoundary: "next_accepted_attempt",
              };
            },
          }),
      },
    });
    const result = await router.rollback({
      operationId: "00000000-0000-4000-8000-000000000123",
      authority,
      confirmation: { state: "confirmed" },
      targetAttemptId: TARGET_ATTEMPT_ID,
      rollbackToken: token,
      reason: "Undo the confirmed preference.",
    });
    expect(result).toMatchObject({
      operation: "rollback",
      outcome: "rolled_back",
      rollback: { supported: false, targetAttemptId: TARGET_ATTEMPT_ID, token: null },
    });
    expect(captured).toMatchObject({
      targetAttempt: {
        id: TARGET_ATTEMPT_ID,
        actor: { kind: "agent", subjectId: "human:target-initiator" },
      },
      targetReceipt,
      rollbackToken: token,
    });
  });

  test("rejects a rollback token that is not bound to the target receipt", async () => {
    const router = createDurableLearningRouter({
      db: {} as Database,
      ledger: ledger({
        get: async () => ({
          initiatingHumanSubjectId: "human:target-initiator",
          decision: {
            disposition: "route",
            destination: "company_profile",
            scope: { kind: "organization" },
            authority: "active",
          },
          receipt: {
            attemptId: TARGET_ATTEMPT_ID,
            inputHash: "c".repeat(64),
            operation: "write",
            outcome: "applied",
            resource: {
              surface: "company_profile",
              id: RESOURCE_ID,
              version: "1",
              status: "active",
            },
            effectiveBoundary: "next_accepted_attempt",
            rollback: { supported: true, targetAttemptId: null, token: "expected" },
            createdAt: NOW,
          },
        }),
      }),
    });
    await expect(
      router.rollback({
        operationId: "00000000-0000-4000-8000-000000000124",
        authority,
        confirmation: { state: "confirmed" },
        targetAttemptId: TARGET_ATTEMPT_ID,
        rollbackToken: "different",
        reason: "Do not accept an unrelated token.",
      }),
    ).rejects.toBeInstanceOf(DurableLearningRollbackUnavailableError);
  });
});
