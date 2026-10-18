// The Connected Machine plane a compute sandbox's agent is reached over.
//
// Every compute box runs Opengeni's machine agent, so the runtime needs the
// same live pieces a Connected Machine session uses: the NATS request/reply
// connection (ControlRpc), the op-stream frame transport, the database read
// that resolves an enrollment's current live connection, and enrollment
// revocation. The runtime leaf owns none of them; the API and worker inject
// them once at boot, exactly as they inject the selfhosted applyDiff.

import type { ControlRpc } from "../selfhosted/control-rpc";
import type { OpStreamTransport } from "../selfhosted/op-transport";

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
}

export interface ComputeAgentPlane {
  /** The request/reply transport. A missing connection answers agent_offline. */
  controlRpc(): ControlRpc;
  /** The op-stream frame transport, or null when the deployment has none. */
  opStreamTransport(): OpStreamTransport | null;
  /** The enrollment's current live connection, or null when it has none
   * (not yet enrolled, asleep past its connection lease, or revoked). */
  resolveConnection(input: {
    workspaceId: string;
    enrollmentId: string;
  }): Promise<ComputeAgentConnection | null>;
  /** Revoke the sandbox enrollment (idempotent; absent is success). */
  revokeEnrollment(input: { workspaceId: string; enrollmentId: string }): Promise<void>;
}

let injectedPlane: ComputeAgentPlane | undefined;

/** Installed once by the API and worker at boot. */
export function setComputeAgentPlane(plane: ComputeAgentPlane | undefined): void {
  injectedPlane = plane;
}

export function getComputeAgentPlane(): ComputeAgentPlane {
  if (!injectedPlane) {
    throw new Error(
      "compute sandbox: the agent plane is not installed in this process (the API and worker install it at boot when OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true)",
    );
  }
  return injectedPlane;
}
