import type {
  ResourceRef,
  SessionStatus,
  TimelineAnnotation,
  TimelineAnnotationSource,
  ToolAuthNeededPayload,
  ToolRef,
} from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Timeline item types

   The projected, renderable shapes that `buildTimeline` folds a session's raw
   event log into. These are the data contract the renderer registry and every
   row component consume — the SINGLE SOURCE OF TRUTH used by both the live app
   and the component demo.
   -------------------------------------------------------------------------- */

export type TimelineAnnotationSourceDescriptor = Omit<
  TimelineAnnotationSource,
  "startOffset" | "endOffset" | "contextBefore" | "contextAfter"
> & {
  text: string;
};

export type UserMessageItem = {
  kind: "user-message";
  id: string;
  text: string;
  annotations?: TimelineAnnotation[] | undefined;
  annotationSource?: TimelineAnnotationSourceDescriptor | undefined;
  presentation?: {
    kind: "realtime_voice" | "realtime_voice_handoff";
    /** Full bounded execution context sent with this visible voice request. */
    context: string;
  };
  /** Resources attached to this message (file uploads, repositories). */
  resources: ResourceRef[];
  /** Tools requested for the turn this message starts. */
  tools: ToolRef[];
  occurredAt: string;
};

export type AgentMessageItem = {
  kind: "agent-message";
  id: string;
  turnId: string | null;
  text: string;
  /** Still receiving deltas (no completed/turn-end seen yet). */
  streaming: boolean;
  occurredAt: string;
  /** Available only after the canonical completed event lands. */
  annotationSource?: TimelineAnnotationSourceDescriptor | undefined;
};

export type ReasoningItem = {
  kind: "reasoning";
  id: string;
  turnId: string | null;
  text: string;
  streaming: boolean;
  occurredAt: string;
};

/**
 * Bounded delivery metadata carried by a projected tool-output event. The
 * canonical event remains unchanged; this fact only explains what the current
 * timeline surface could render and whether separately retained full evidence
 * exists.
 */
export type ToolCallTruncation = {
  truncated: true;
  surface: string;
  reason: string;
  omittedBytes: number | null;
  fullEvidence: {
    available: boolean;
    reason: string | null;
  };
};

export type ToolCallItem = {
  kind: "tool-call";
  id: string;
  turnId: string | null;
  callId: string | null;
  name: string;
  arguments: unknown;
  output: unknown;
  truncation?: ToolCallTruncation | null;
  /**
   * The provider-native tool item (`agent.toolCall.created.payload.raw`). Carries
   * `type` (e.g. `apply_patch_call`, `computer_call`, `hosted_tool_call`) and the
   * tool-specific fields the per-tool renderers read (`operation`, `action`,
   * `providerData`, …). `undefined` for first-party MCP tools, which carry their
   * payload in `arguments`/`output` instead.
   */
  raw: unknown;
  status: "running" | "complete" | "failed" | "cancelled";
  occurredAt: string;
  /** Canonical textual projection of the settled tool output. */
  annotationSource?: TimelineAnnotationSourceDescriptor | undefined;
};

/**
 * An orchestration call against another session — the manager spawning or
 * messaging a worker. Rendered as a first-class "worker" row, not a generic
 * tool call.
 */
export type WorkerItem = {
  kind: "worker";
  id: string;
  turnId: string | null;
  callId: string | null;
  action: "spawn" | "message";
  /** The worker's initial message / the message sent to it, when parseable. */
  prompt: string | null;
  /** The target/spawned worker session id, when parseable from args/output. */
  workerSessionId: string | null;
  status: "running" | "complete" | "failed" | "cancelled";
  occurredAt: string;
};

export type WorkerCompletionItem = {
  kind: "worker-completion";
  id: string;
  turnId: string | null;
  occurredAt: string;
  childSessionId: string;
  childStatus: string;
  goalStatus: string | null;
  goalText: string | null;
  evidence: string | null;
  pausedReason: string | null;
  text: string;
};

export type SandboxItem = {
  kind: "sandbox";
  id: string;
  turnId: string | null;
  name: string;
  command: string | null;
  output: string;
  origin?: "created" | "restored" | "resumed" | null;
  status: "running" | "complete" | "failed" | "cancelled";
  occurredAt: string;
};

/**
 * A first-party workspace-memory write the agent made mid-turn — a `memory.saved`
 * (it committed a new preference / fact / procedure / decision / history) or a
 * `memory.corrected` (it updated or archived an existing one). A settled save is
 * ordinary progress, not an exceptional state, so it renders as a calm NEUTRAL
 * step on the rail (never accent/color). When the host app supplies an
 * `onMemoryClick` handler the row also deep-links to the record in its memory
 * pane; without one it is non-interactive rich content.
 */
export type MemoryItem = {
  kind: "memory";
  id: string;
  turnId: string | null;
  variant: "saved" | "corrected";
  /** The memory's kind enum (`"preference" | "semantic" | …`); mapped to a human label at render. */
  memoryKind: string;
  /** The memory text, ellipsized to ≤120 chars server-side. For a supersede this is the OLD text. */
  preview: string;
  /** The save collapsed into an existing memory (no new row was written). Saved variant only. */
  deduped?: boolean;
  /** The NEW text when a correction superseded the memory with a replacement; absent = updated-in-place or archived. */
  replacementPreview?: string;
  /**
   * What a `memory.corrected` did: `"superseded"` (replaced by a new record, see
   * `replacementPreview`), `"updated"` (edited in place — the record lives on), or
   * `"archived"` (retired). Distinguishes updated-in-place from archived when there
   * is no replacement. Corrected variant only; read defensively (may be absent).
   */
  action?: string;
  /** The saved / corrected memory's id — the deep-link target for a save. */
  memoryId: string;
  /** The replacement memory's id when a correction produced one — the LIVE record the deep-link targets. */
  replacementMemoryId?: string;
  occurredAt: string;
};

export type FleetDecisionScoreItem = {
  candidateKey: string;
  eligible: boolean;
  rejectionReason:
    | "allocator_disabled"
    | "unavailable"
    | "cooling"
    | "quota_ceiling"
    | "overlay_isolation"
    | null;
  total: number;
  confidence: "unknown" | "low" | "medium" | "high";
};

/**
 * One production-vs-shadow placement explanation. Candidate keys are
 * event-local aliases only; no credential/account identity reaches this item.
 */
export type FleetDecisionItem = {
  kind: "fleet-decision";
  id: string;
  turnId: string | null;
  policyVersion: "adaptive-shadow-v1";
  actualOutcome: "selected" | "waiting" | "none";
  actualCandidateKey: string | null;
  actualReason: "lease_reused" | "pin" | "rotation" | "active" | "all_capped" | "none";
  shadowOutcome: "selected" | "paced" | "none";
  shadowCandidateKey: string | null;
  shadowReason:
    | "fenced_in_flight"
    | "fenced_candidate_missing"
    | "admission_paced"
    | "no_eligible_candidate"
    | "overlay_isolated_empty"
    | "best_score"
    | "affinity_best"
    | "hysteresis_hold";
  comparison: "match" | "different_candidate" | "different_outcome" | "not_comparable_truncated";
  confidence: "unknown" | "low" | "medium" | "high";
  admissionOutcome: "admit" | "pace";
  admissionReason:
    | "fenced_in_flight"
    | "pacing_disabled"
    | "capacity_unknown"
    | "capacity_available"
    | "work_conserving_borrow"
    | "manager_priority"
    | "standard_starvation_bound"
    | "capacity_saturated"
    | "emergency_fuse";
  borrowedIdleCapacity: boolean;
  borrowedOverlayCapacity: boolean;
  strandedEligibleCount: number;
  candidateCount: number;
  truncatedCandidateCount: number;
  scoreRowsTruncatedCount: number;
  scores: FleetDecisionScoreItem[];
  occurredAt: string;
};

export type SessionStatusItem = {
  kind: "session-status";
  id: string;
  status: SessionStatus;
  occurredAt: string;
};

export type GoalItem = {
  kind: "goal";
  id: string;
  action: "set" | "updated" | "completed" | "paused" | "resumed" | "cleared" | "continuation";
  text: string | null;
  occurredAt: string;
};

export type NoticeItem = {
  kind: "notice";
  id: string;
  tone: "waiting" | "cancelled" | "failed" | "input";
  text: string;
  /** Optional evidence kept inspectable without overwhelming the main rail. */
  details?: { label: string; value: unknown };
  action?: { label: string; url: string };
  occurredAt: string;
};

/**
 * First-class conversation-memory checkpoint. Stays outside collapsed turns so
 * auto-compaction cannot vanish behind a chevron. Chat bubbles are unchanged.
 */
export type ContextCompactionItem = {
  kind: "context-compaction";
  id: string;
  turnId: string | null;
  phase: "started" | "compacted" | "skipped";
  trigger: "auto" | "operator" | "proactive" | "overflow" | null;
  estimatedTokensBefore: number | null;
  estimatedTokensAfter: number | null;
  skipReason: string | null;
  /** Provider implementation id for debug disclosure only. */
  implementation: string | null;
  occurredAt: string;
};

export type MachineInputMember = {
  id: string;
  kind:
    | "scheduled_occurrence"
    | "goal_continuation"
    | "agent_message"
    | "agent_steer_instruction"
    | "child_terminal_result";
  classification: "success" | "failure" | "action_required" | "info";
  sourceId: string;
  summary: string;
};

/**
 * One or more durable non-human inputs that joined the following agent turn.
 * This is communication, not a warning or a protocol-debug payload.
 */
export type MachineInputBatchItem = {
  kind: "machine-input-batch";
  id: string;
  turnId: string | null;
  members: MachineInputMember[];
  occurredAt: string;
};

/**
 * A tool call hit a missing or lapsed connection. The broker reports that
 * condition as a tool error and the turn continues; reconnecting never resumes
 * or replays the original call. Carries the structured `tool.auth_needed`
 * payload so the renderer can draw a clean inline recovery affordance (provider
 * logo + one human line + a Connect/Reconnect button) and the app can start the
 * right flow (OAuth reconnect for the surviving connection, or credential
 * re-entry for an api-key one). The `reason` shapes the human copy but is never
 * shown raw.
 */
export type AuthNeededItem = {
  kind: "auth-needed";
  id: string;
  turnId: string | null;
  /** The runtime surface that requested recovery, when the event is an MCP auth signal. */
  serverId: string | null;
  /** Durable event family that produced this notice. */
  source?: "tool" | "credential" | undefined;
  /** The connection's registrable domain, e.g. "linear.app". */
  providerDomain: string;
  /** The lapsed connection to reconnect, when the row survived. */
  connectionId: string | null;
  reason: ToolAuthNeededPayload["reason"] | null;
  /** Scopes the provider now needs; may inform the copy, never shown as a raw label. */
  scopes: string[];
  /** The OAuth `resource` (RFC 8707) the reconnect should target, when supplied. */
  resource: string | null;
  /** The tool whose call triggered the reauth, for context. */
  toolName: string | null;
  /** A pre-minted authorization URL, when the broker already produced one. */
  authorizationUrl: string | null;
  occurredAt: string;
};

export type TurnOutcome = "complete" | "failed" | "cancelled";

export type TurnEndItem = {
  kind: "turn-end";
  id: string;
  turnId: string | null;
  outcome: TurnOutcome;
  failureText: string | null;
  occurredAt: string;
};

export type TimelineItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | WorkerItem
  | WorkerCompletionItem
  | SandboxItem
  | SessionStatusItem
  | GoalItem
  | NoticeItem
  | ContextCompactionItem
  | MachineInputBatchItem
  | AuthNeededItem
  | MemoryItem
  | FleetDecisionItem
  | TurnEndItem;

/** Activity items cluster between chat messages (reasoning, tools, workers, sandbox, memory). */
export type ActivityItem =
  | ReasoningItem
  | ToolCallItem
  | WorkerItem
  | SandboxItem
  | MemoryItem
  | FleetDecisionItem;

export type TimelineGroup =
  | { kind: "item"; item: TimelineItem }
  | {
      kind: "activity";
      id: string;
      items: ActivityItem[];
      outcome?: TurnOutcome;
      failureText?: string;
    }
  | {
      kind: "turn";
      id: string;
      outcome: TurnOutcome;
      failureText?: string;
      startedAt: string;
      endedAt: string;
      groups: TimelineGroup[];
      /** Adjacent compaction landmark just before this fold (secondary chip facet). */
      contextCompactionCount?: number;
    };
