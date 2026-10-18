// The agent plane of compute sandboxes (packages/runtime/src/sandbox/compute):
// the live pieces a compute sandbox's agent is reached over, built from the
// process's database and NATS bus. The API and worker install it at boot; the
// compute provider uses it only when a session selects compute.

import type { Settings } from "@opengeni/config";
import {
  createSandboxEnrollment,
  getLiveEnrollmentConnection,
  revokeSandboxEnrollment,
  type Database,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  NatsControlRpc,
  NatsOpStreamTransport,
  setComputeAgentPlane,
  type ComputeAgentPlane,
  type NatsRequestConnection,
} from "@opengeni/runtime/sandbox";

export function createComputeAgentPlane(deps: {
  db: Database;
  bus: EventBus;
  settings: Pick<Settings, "agentOpStreamEnabled">;
}): ComputeAgentPlane {
  const { db, bus, settings } = deps;
  const opStream =
    settings.agentOpStreamEnabled === true && bus.getOpStreamConnection
      ? new NatsOpStreamTransport(async () => bus.getOpStreamConnection?.() ?? null)
      : null;
  return {
    controlRpc: () =>
      new NatsControlRpc(
        async (): Promise<NatsRequestConnection | null> => bus.getRequestConnection(),
      ),
    opStreamTransport: () => opStream,
    resolveConnection: async ({ workspaceId, enrollmentId }) => {
      // A sandbox enrollment's claim is renewed by the agent gateway while its
      // host holds the session open, asleep or not: a live claim is reachable.
      const enrollment = await getLiveEnrollmentConnection(db, workspaceId, enrollmentId);
      if (!enrollment?.connectionInstanceId || enrollment.kind !== "sandbox") return null;
      return {
        workspaceId: enrollment.workspaceId,
        connectionInstanceId: enrollment.connectionInstanceId,
        workspaceRoot: enrollment.workspaceRoot,
        opStream: enrollment.opStream === true,
        transactionalFsWriteSupported: enrollment.agentCapabilities.transactionalFsWrite === true,
        browserControlHttpSupported: enrollment.agentCapabilities.browserControlHttp === true,
        runAsSupported: enrollment.agentCapabilities.runAs === true,
      };
    },
    createEnrollment: async (input) => {
      await createSandboxEnrollment(db, input);
    },
    revokeEnrollment: async (input) => {
      await revokeSandboxEnrollment(db, input);
    },
  };
}

/** Install the compute agent plane for this process (the API and worker call
 * this once at boot). Cheap and inert until a session selects compute. */
export function installComputeAgentPlane(deps: {
  db: Database;
  bus: EventBus;
  settings: Pick<Settings, "agentOpStreamEnabled">;
}): void {
  setComputeAgentPlane(createComputeAgentPlane(deps));
}
