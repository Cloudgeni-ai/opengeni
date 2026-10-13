import {
  attachQualifiedModalNativeBrokerSession,
  wrapChannelABoxWithRouting,
} from "@opengeni/core";
import {
  acquireLease,
  releaseLeaseHolder,
  touchLeaseHolder,
  SandboxLeaseSupersededError,
} from "@opengeni/db";
import type { LeaseSnapshot } from "@opengeni/db";
import { sandboxLifecycleTransitionWaitMs, sandboxWarmRateMicrosPerSecond } from "@opengeni/config";
import type { Session } from "@opengeni/contracts";
import type { EstablishedSandboxSession } from "@opengeni/runtime/sandbox";
import type { ViewerServices } from "./viewer";

/** Viewer authorization was already established by the stream-mint caller.
 * Broker setup is still a real workspace command: acquire an exact retained
 * instance's direct holder and use the same canonical routing/admission ledger
 * as Channel A. Never create, follow a changed active machine, or use TaskExec.
 * Legacy providers retain their existing setup path. The caller owns its borrow. */
export async function withViewerBrokerSetup<T>(
  services: ViewerServices,
  input: {
    accountId: string;
    workspaceId: string;
    session: Session;
    lease: LeaseSnapshot;
    resourceSubjectId?: string | null;
    established: EstablishedSandboxSession;
  },
  operation: (session: unknown) => Promise<T>,
): Promise<T> {
  const { db, settings } = services;
  const { accountId, workspaceId, session, lease, established } = input;
  const scope = { accountId, workspaceId, sandboxGroupId: session.sandboxGroupId };
  if (
    session.sandboxBackend !== "modal" ||
    !(await attachQualifiedModalNativeBrokerSession({
      db,
      settings,
      scope,
      session: established.session,
    }))
  )
    return await operation(established.session);
  if (!input.resourceSubjectId || !lease.instanceId || established.instanceId !== lease.instanceId)
    throw new Error("Native broker viewer setup requires an authorized exact home instance");
  const requestId = crypto.randomUUID();
  const holderId = `direct:${requestId}`;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const acquired = await acquireLease(db, {
      ...scope,
      kind: "direct",
      holderId,
      subjectId: session.id,
      backend: "modal",
      os: session.sandboxOs,
      retainedInstanceId: lease.instanceId,
      warmBilling: {
        mode: settings.sandboxWarmBillingMode,
        rateMicrosPerSecond: sandboxWarmRateMicrosPerSecond(settings, "modal"),
      },
      leaseTtlMs: settings.sandboxLeaseTtlMs,
      warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
      captureWaitMs: sandboxLifecycleTransitionWaitMs(settings),
    });
    if (
      (acquired.role !== "attached" && acquired.role !== "rearmed") ||
      acquired.lease.liveness !== "warm" ||
      acquired.lease.leaseEpoch !== lease.leaseEpoch ||
      acquired.lease.instanceId !== lease.instanceId
    )
      throw new SandboxLeaseSupersededError(scope.sandboxGroupId, lease.leaseEpoch);
    heartbeat = setInterval(() => {
      void touchLeaseHolder(db, { ...scope, kind: "direct", holderId }).catch(() => undefined);
    }, 10_000);
    heartbeat.unref?.();
    const routed = wrapChannelABoxWithRouting(
      services,
      {
        accountId,
        workspaceId,
        sessionId: session.id,
        resourceSubjectId: input.resourceSubjectId,
        homeOnly: true,
        homeLease: {
          sandboxGroupId: scope.sandboxGroupId,
          leaseEpoch: lease.leaseEpoch,
          instanceId: lease.instanceId,
          backend: "modal",
        },
        directRequest: { requestId, holderId },
      },
      established,
    );
    return await operation(routed.session);
  } finally {
    clearInterval(heartbeat);
    // An ambiguous command remains retained/fenced; holder release is never
    // substituted for a native exit or workspace-writer settlement receipt.
    await releaseLeaseHolder(db, {
      ...scope,
      kind: "direct",
      holderId,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
  }
}
