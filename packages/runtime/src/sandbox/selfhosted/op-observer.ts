// The transport-agnostic per-op observation seam for the Connected Machine
// (selfhosted) control path — the out-of-band audience of the failure-visibility
// doctrine (op outcomes + healed faults land in metrics + `machine.*` events so
// problems are learnable over time).
//
// It is DELIBERATELY transport-agnostic (op-shaped, not request/reply-shaped): the
// op-engine's future op-stream client (ENGINE-INTEGRATION.md step 6) emits through
// this SAME interface, so the metrics + `machine.*` events keep flowing unchanged
// across the transport swap. The runtime leaf only INVOKES the observer; the
// worker/api adapt it to the concrete sinks (a metrics hook, a durable session
// event), so the leaf stays agent-loop-free and db-free.

import type { ErrorCode } from "@opengeni/agent-proto";
import type { SelfhostedUnavailableReason } from "./control-rpc";

/**
 * One completed control-op observation. `outcome` is the terminal result AFTER any
 * in-call retries: `ok` (the op succeeded) or `failed` (a terminal fault surfaced).
 * `healed` marks a success that only landed after ≥1 retry — the doctrine's
 * "healed and invisible in-band, always out-of-band" breadcrumb (drives
 * `machine.op.recovered`). Every field is derivable at the `SelfhostedSession.call`
 * exit points with no extra round-trip.
 */
export interface SelfhostedOpObservation {
  /** The control-op kind (`ControlRequest["op"].$case`): exec / fsRead / ping / … */
  op: string;
  outcome: "ok" | "failed";
  /** True when `outcome==="ok"` only after ≥1 in-call retry (draining/timeout/never-sent). */
  healed: boolean;
  /** Total in-call retries before this outcome (summed across the retry classes). */
  retries: number;
  /** Wall time from the first attempt to the terminal outcome, in ms. */
  durationMs: number;
  /** The typed wire code — present on `failed`. */
  code?: ErrorCode;
  /** The negotiated capability reason (agent_offline / agent_reconnecting / …), if any. */
  reason?: SelfhostedUnavailableReason | null;
  /** Whether a failed fault provably never reached the machine (a pre-send synthesis). */
  neverSent?: boolean;
  /** The enrolled machine (agent) id the op addressed — for machine-scoped fan-out. */
  machineId?: string;
  /** A stable fault-class string (`selfhostedFaultClass`): the fault class on a
   *  `failed` op, or the class of retries that a `healed` op recovered from. Absent
   *  on a clean success. Drives the `machine.op.*` event mapping + its infra filter. */
  faultClass?: string;
  /** The reply size in bytes when known — set on a PAYLOAD_TOO_LARGE fault (from the
   *  agent's `encoded_bytes` detail). The op-stream client fills the success-reply
   *  size once it owns the framed transport; today's request/reply does not surface it. */
  replyBytes?: number;
}

/** A fire-and-forget observer of completed control ops. It MUST NOT throw (the
 *  session guards the call) and MUST NOT block the op — it is a telemetry tap. */
export type SelfhostedOpObserver = (observation: SelfhostedOpObservation) => void;
