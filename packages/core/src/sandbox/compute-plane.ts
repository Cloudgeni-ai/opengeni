// The agent plane of compute sandboxes (packages/runtime/src/sandbox/compute):
// the live pieces a compute sandbox's agent is reached over, built from the
// process's database and NATS bus. The API and worker install it at boot; the
// compute provider uses it only when a session selects compute.

import type { Settings } from "@opengeni/config";
import {
  createSandboxEnrollment,
  getEnrollment,
  getLiveEnrollmentConnection,
  revokeSandboxEnrollment,
  type Database,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  NatsControlRpc,
  NatsOpStreamTransport,
  parseAgentRpcSubject,
  setComputeAgentPlane,
  type ComputeAgentPlane,
  type NatsRequestConnection,
} from "@opengeni/runtime/sandbox";

/** A compute sandbox's agent that does not serve `OpRelease`: its image was
 * built with an agent older than this release. Compute sandboxes carry an agent
 * from their image and never update it, and they have no older path for
 * releasing command output, so the sandbox is refused, not run with polling. */
export class ComputeAgentIncompatibleError extends Error {
  constructor(readonly enrollmentId: string) {
    super(
      "This compute sandbox's agent is too old: it does not support releasing command output (capabilities.op_release). Rebuild the sandbox image with the agent from this Opengeni release or later.",
    );
    this.name = "ComputeAgentIncompatibleError";
  }
}

/** Whether a sandbox enrollment's agent reported capabilities that lack
 * `OpRelease`. Before its Hello is recorded nothing is known, and nothing is
 * refused. */
export function computeAgentLacksOutputRelease(capabilities: Record<string, boolean>): boolean {
  return Object.keys(capabilities).length > 0 && capabilities.opRelease !== true;
}

/**
 * Whether the agent connection an RPC subject names is still its enrollment's
 * live one. Every call reads the enrollment from the database, which every API
 * and worker process shares, so a replacement recorded by any of them (for
 * example the gateway on another pod opening the new agent's session) is seen
 * at once; nothing is cached in the process. An unknown answer (a failed read,
 * a subject that names no agent connection, an enrollment with no live
 * connection) counts as current. A Connected Machine and a compute sandbox are
 * read the same way.
 */
export function agentConnectionCurrent(db: Database): (subject: string) => Promise<boolean> {
  return async (subject) => {
    const target = parseAgentRpcSubject(subject);
    if (!target) return true;
    try {
      const enrollment = await getEnrollment(db, target.workspaceId, target.agentId);
      return (
        !enrollment?.connectionInstanceId ||
        enrollment.connectionInstanceId === target.connectionInstanceId
      );
    } catch {
      return true;
    }
  };
}

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
    controlRpc: (options) =>
      new NatsControlRpc(
        async (): Promise<NatsRequestConnection | null> => bus.getRequestConnection(),
        options?.onNoResponders ? { onNoResponders: options.onNoResponders } : {},
      ),
    opStreamTransport: () => opStream,
    resolveConnection: async ({ workspaceId, enrollmentId }) => {
      // A sandbox enrollment's claim is renewed by the agent gateway while its
      // host holds the session open, asleep or not: a live claim is reachable.
      const enrollment = await getLiveEnrollmentConnection(db, workspaceId, enrollmentId);
      if (!enrollment?.connectionInstanceId || enrollment.kind !== "sandbox") return null;
      if (computeAgentLacksOutputRelease(enrollment.agentCapabilities))
        throw new ComputeAgentIncompatibleError(enrollmentId);
      return {
        workspaceId: enrollment.workspaceId,
        connectionInstanceId: enrollment.connectionInstanceId,
        workspaceRoot: enrollment.workspaceRoot,
        opStream: enrollment.opStream === true,
        transactionalFsWriteSupported: enrollment.agentCapabilities.transactionalFsWrite === true,
        transactionalFsWriteMachineSupported:
          enrollment.agentCapabilities.transactionalFsWriteMachine === true,
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
