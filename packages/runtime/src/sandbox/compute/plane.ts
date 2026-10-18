// The Connected Machine plane a compute sandbox's agent is reached over.
//
// Every compute sandbox runs Opengeni's machine agent, reached through its
// host's link to the agent gateway, which puts the agent's traffic on
// Opengeni's NATS exactly where a Connected Machine's would be. So the runtime
// needs the same live pieces a Connected Machine session uses: the NATS
// request/reply connection (ControlRpc), the op-stream frame transport, the
// database read that resolves an enrollment's current live connection, and the
// sandbox enrollment's creation and revocation. The runtime leaf owns none of
// them; the API and worker inject them once at boot.

import type { ControlRpc } from "../selfhosted/control-rpc";
import type { OpStreamTransport } from "../selfhosted/op-transport";

/**
 * Whether a backend's provider session is the machine agent reached over NATS
 * and the relay (a Connected Machine, or the agent inside a compute sandbox).
 * Transport points (relay terminal and desktop frames, the agent's error
 * grammar) key on this; lease and provisioning points still treat compute as
 * a managed sandbox.
 */
export function usesAgentTransport(backend: string | null | undefined): boolean {
  return backend === "selfhosted" || backend === "compute";
}

/** One authoritative snapshot of the box agent's live connection. */
export interface ComputeAgentConnection {
  /** Control-plane workspace segment of the agent subject. */
  workspaceId: string;
  connectionInstanceId: string;
  /** The workspace root the agent reported in its Hello. */
  workspaceRoot: string | null;
  /** The agent advertised the op-stream exec protocol. */
  opStream: boolean;
  transactionalFsWriteSupported: boolean;
  browserControlHttpSupported: boolean;
  /** The agent advertised per-request `run_as` (Hello `capabilities.run_as`). */
  runAsSupported: boolean;
}

export interface ComputeAgentPlane {
  /** The request/reply transport. A missing connection answers agent_offline.
   * `onNoResponders` runs on each "no responders" of a replayable request
   * before the same delivery is retried; false stops retrying. */
  controlRpc(options?: { onNoResponders?: (subject: string) => Promise<boolean> }): ControlRpc;
  /** The op-stream frame transport, or null when the deployment has none. */
  opStreamTransport(): OpStreamTransport | null;
  /** The enrollment's current live connection, or null when it has none (its
   * host has not opened the agent's session at the gateway, or it was revoked).
   * A sleeping sandbox's session stays open, so it resolves. */
  resolveConnection(input: {
    workspaceId: string;
    enrollmentId: string;
  }): Promise<ComputeAgentConnection | null>;
  /** Create the sandbox's enrollment, active at once and keyless, bound to the
   * sandbox group (idempotent for the same id and group). */
  createEnrollment(input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    sandboxGroupId: string;
    hasDisplay: boolean;
    workspaceRoot: string;
  }): Promise<void>;
  /** Revoke the sandbox enrollment, which ends its session at the gateway
   * (idempotent; absent is success). */
  revokeEnrollment(input: { workspaceId: string; enrollmentId: string }): Promise<void>;
  /** The active sandbox enrollments of one sandbox group with their creation
   * times: each one may still have a sandbox at the fabric. */
  listGroupEnrollments(input: {
    workspaceId: string;
    sandboxGroupId: string;
  }): Promise<Array<{ enrollmentId: string; createdAtMs: number }>>;
}

let injectedPlane: ComputeAgentPlane | undefined;

/** Installed once by the API and worker at boot. */
export function setComputeAgentPlane(plane: ComputeAgentPlane | undefined): void {
  injectedPlane = plane;
}

export function getComputeAgentPlane(): ComputeAgentPlane {
  if (!injectedPlane) {
    throw new Error(
      "compute sandbox: the agent plane is not installed in this process (the API and worker install it at boot when the compute backend is configured)",
    );
  }
  return injectedPlane;
}
