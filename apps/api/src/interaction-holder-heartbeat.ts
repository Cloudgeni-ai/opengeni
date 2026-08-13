import type { AccessGrant } from "@opengeni/contracts";
import { touchInteractionOperation, touchLeaseHolder } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";

const MAX_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Keep one durable interaction operation—and its sandbox holder when present—
 * live while a bounded controller mutation is in flight. Browser profile
 * capture/restore can legitimately take minutes; without this pulse a lifecycle
 * reaper cannot distinguish that request from a caller that disappeared.
 */
export async function withInteractionHolderHeartbeat<T>(
  deps: ApiRouteDeps,
  input: {
    grant: AccessGrant;
    workspaceId: string;
    sandboxGroupId: string | null;
    holderId: string;
    operationId: string;
    resourceId: string;
    controllerGeneration: string;
  },
  run: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(
    1_000,
    Math.min(
      MAX_HEARTBEAT_INTERVAL_MS,
      Math.floor(deps.settings.sandboxInteractionHolderTtlMs / 3),
    ),
  );
  let stopped = false;
  let authorityLost = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> = Promise.resolve();

  const pulse = async (): Promise<void> => {
    try {
      const [operationAlive, holderAlive] = await Promise.all([
        touchInteractionOperation(deps.db, {
          accountId: input.grant.accountId,
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          resourceId: input.resourceId,
          controllerGeneration: input.controllerGeneration,
        }),
        input.sandboxGroupId
          ? touchLeaseHolder(deps.db, {
              accountId: input.grant.accountId,
              workspaceId: input.workspaceId,
              sandboxGroupId: input.sandboxGroupId,
              kind: "interaction",
              holderId: input.holderId,
            })
          : Promise.resolve(true),
      ]);
      if (!operationAlive || !holderAlive) authorityLost = true;
    } catch (error) {
      // A transient database error does not surrender controller authority. The
      // next pulse can recover, and the operation's authoritative settlement
      // still goes through the database before it is exposed as complete.
      deps.observability?.warn("interaction holder heartbeat failed", {
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxGroupId,
        holderId: input.holderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      pending = pulse().finally(schedule);
    }, intervalMs);
    timer.unref?.();
  };

  await pulse();
  if (authorityLost) {
    throw new Error("Interaction controller placement authority was lost");
  }
  schedule();
  try {
    const result = await run();
    if (authorityLost) {
      throw new Error("Interaction controller placement authority was lost");
    }
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  }
}
