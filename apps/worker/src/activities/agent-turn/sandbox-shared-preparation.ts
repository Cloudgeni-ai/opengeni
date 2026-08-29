import { randomUUID } from "node:crypto";

import {
  claimSandboxSharedPreparation,
  readSandboxSharedPreparation,
  SandboxLeaseSupersededError,
  settleSandboxSharedPreparation,
  type Database,
} from "@opengeni/db";

import type { ResumedTurnSandbox } from "../../sandbox-resume";

type SharedRigSetupCoordinatorInput = {
  specHash: string;
  timeoutMs: number;
  execute: () => Promise<void>;
};

type SharedRigSetupCoordinatorOptions = {
  db: Database;
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  attemptId: string;
  holderId: string;
  sandbox: ResumedTurnSandbox;
  signal?: AbortSignal;
  observe?: (measurement: {
    path: "owner" | "joined" | "reused";
    outcome: "completed" | "failed";
    durationSeconds: number;
  }) => void;
};

function observeSharedPreparation(
  options: SharedRigSetupCoordinatorOptions,
  measurement: Parameters<NonNullable<SharedRigSetupCoordinatorOptions["observe"]>>[0],
): void {
  try {
    options.observe?.(measurement);
  } catch {
    // Telemetry must never alter setup authority or settlement.
  }
}

function waitForPreparationTransition(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(finish, ms);
    function finish(): void {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal?.reason ?? new Error("Sandbox shared preparation wait cancelled"));
    }
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function settleCompletedWithRetry(
  options: SharedRigSetupCoordinatorOptions,
  input: SharedRigSetupCoordinatorInput,
  claimId: string,
): Promise<boolean> {
  let delayMs = 50;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (
        await settleSandboxSharedPreparation(options.db, {
          accountId: options.accountId,
          workspaceId: options.workspaceId,
          sandboxGroupId: options.sandboxGroupId,
          expectedLeaseEpoch: options.sandbox.leaseEpoch,
          expectedInstanceId: options.sandbox.established.instanceId,
          specHash: input.specHash,
          holderId: options.holderId,
          claimId,
          outcome: "completed",
        })
      ) {
        return true;
      }
    } catch {
      // The exact claim remains durable. Retry settlement without replaying the
      // provider operation; a later owner can verify the box-local marker.
    }
    await waitForPreparationTransition(delayMs, options.signal);
    delayMs *= 2;
  }
  return false;
}

/**
 * Coordinate immutable rig setup across workers. Joiners use a revision-aware,
 * exponentially backed-off durable read instead of the old fixed 250 ms lease
 * polling pattern. PostgreSQL remains source of truth; a lost completion write
 * is recovered by the next deadline owner through the hook's box-local marker.
 */
export function createSharedRigSetupCoordinator(
  options: SharedRigSetupCoordinatorOptions,
): (input: SharedRigSetupCoordinatorInput) => Promise<"executed" | "reused"> {
  return async (input) => {
    const startedAt = performance.now();
    const claimId = randomUUID();
    const identity = {
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      sandboxGroupId: options.sandboxGroupId,
      expectedLeaseEpoch: options.sandbox.leaseEpoch,
      expectedInstanceId: options.sandbox.established.instanceId,
      specHash: input.specHash,
      holderId: options.holderId,
    };
    const claimTimeoutMs = Math.min(3_600_000, Math.max(30_000, input.timeoutMs + 30_000));
    let delayMs = 100;
    let observedRevision = -1;
    let path: "owner" | "joined" | "reused" = "owner";

    try {
      for (;;) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? new Error("Sandbox shared preparation cancelled");
        }
        const claim = await claimSandboxSharedPreparation(options.db, {
          ...identity,
          claimId,
          ownerAttemptId: options.attemptId,
          timeoutMs: claimTimeoutMs,
        });
        if (claim.role === "fenced") {
          throw new SandboxLeaseSupersededError(options.sandboxGroupId, options.sandbox.leaseEpoch);
        }
        if (claim.role === "reused") {
          if (path !== "joined") path = "reused";
          observeSharedPreparation(options, {
            path,
            outcome: "completed",
            durationSeconds: (performance.now() - startedAt) / 1_000,
          });
          return "reused";
        }
        if (claim.role === "owner") {
          try {
            await input.execute();
          } catch (error) {
            await settleSandboxSharedPreparation(options.db, {
              ...identity,
              claimId,
              outcome: "failed",
            }).catch(() => undefined);
            throw error;
          }
          if (await settleCompletedWithRetry(options, input, claimId)) {
            observeSharedPreparation(options, {
              path,
              outcome: "completed",
              durationSeconds: (performance.now() - startedAt) / 1_000,
            });
            return "executed";
          }
          throw new Error(
            "Sandbox shared preparation completed but its durable settlement remains unavailable",
          );
        }

        path = "joined";
        observedRevision = claim.preparation.revision;
        const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(delayMs / 4)));
        await waitForPreparationTransition(delayMs + jitterMs, options.signal);
        const observed = await readSandboxSharedPreparation(options.db, identity);
        if (observed.status === "fenced") {
          throw new SandboxLeaseSupersededError(options.sandboxGroupId, options.sandbox.leaseEpoch);
        }
        if (observed.preparation.status === "completed") {
          observeSharedPreparation(options, {
            path,
            outcome: "completed",
            durationSeconds: (performance.now() - startedAt) / 1_000,
          });
          return "reused";
        }
        if (observed.preparation.status === "failed") {
          delayMs = 100;
          continue;
        }
        delayMs =
          observed.preparation.revision === observedRevision ? Math.min(2_000, delayMs * 2) : 100;
      }
    } catch (error) {
      observeSharedPreparation(options, {
        path,
        outcome: "failed",
        durationSeconds: (performance.now() - startedAt) / 1_000,
      });
      throw error;
    }
  };
}
