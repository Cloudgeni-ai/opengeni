import type { MachineBackend, MachineExecTransport } from "@opengeni/runtime/sandbox";
import type { SandboxV2BackgroundCommandAuthority } from "@opengeni/db";

/** Trusted host installation, separate from fresh-admission qualification.
 * Existing machines keep their adapter even when fresh admission is disabled.
 * Missing adapters defer recovery; there is no legacy/provider fallback. */
export type SandboxV2ControlProviders = ReadonlyMap<
  string,
  {
    backend: MachineBackend;
    transport: MachineExecTransport;
    /** Explicit network contract for native attachment downloads. */
    fileDownloadAudience?: "public" | "sandbox";
    /** Installed current job control permission, independent of an ended
     * turn's credential broker. Absence defers pending job recovery. */
    authorizeBackgroundJobControl?: (
      authority: SandboxV2BackgroundCommandAuthority,
    ) => Promise<void>;
  }
>;

export type SandboxV2RecoveryCursor = {
  afterDemandId?: string;
  afterOperationId?: string;
  attemptsComplete?: boolean;
  commandsComplete?: boolean;
  afterJobId?: string;
  jobsComplete?: boolean;
};

export const SANDBOX_V2_SWEEP_WORKFLOW_ID = "opengeni-sandbox-machine-v2-sweep";

// Older control binaries poll the legacy lifecycle queue and do not register
// these workflow/activity types. Their tasks must stay on a distinct protocol.
export const SANDBOX_V2_CONTROL_TASK_QUEUE_SUFFIX = "-sandbox-machine-v2";
export function sandboxV2ControlTaskQueue(baseTaskQueue: string): string {
  return baseTaskQueue.endsWith(SANDBOX_V2_CONTROL_TASK_QUEUE_SUFFIX)
    ? baseTaskQueue
    : `${baseTaskQueue}${SANDBOX_V2_CONTROL_TASK_QUEUE_SUFFIX}`;
}
