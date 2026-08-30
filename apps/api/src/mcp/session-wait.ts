/**
 * `session_wait`: one blocking first-party MCP call that replaces the
 * `sleep 55` plus three or four `session_events`/`session_get` probes an agent
 * otherwise runs per loop while it waits for a child or peer session.
 *
 * The durable `session_events` table is the only authority. The NATS event bus
 * is live fanout only, so every wake (bus, deadline, or the initial call) is
 * followed by a database read and the returned rows are always the exact
 * durable events, never the bus payload. Subscriptions are opened before the
 * first read so an event committed between the read and the subscription
 * cannot be missed.
 *
 * Timing facts: the built-in `opengeni` MCP server entry carries no
 * `timeoutMs`, so the worker's MCP client uses the SDK default request timeout
 * of 60 s and a longer call would surface as a `-32001` tool error. The wait is
 * therefore capped at {@link SESSION_WAIT_MAX_SECONDS} both in the tool schema
 * and inside {@link waitForSessionChanges}. The API's `Bun.serve`
 * `idleTimeout` is 255 s, far above that cap.
 *
 * Cancellation: the API serves one transport per POST, so the worker's MCP
 * `notifications/cancelled` never reaches this handler; instead the route binds
 * the HTTP request's own abort to `transport.close()` (`request-abort.ts`),
 * which aborts `extra.signal`. A worker that drops the call on Steer/Pause
 * therefore ends the server-side wait promptly; the deadline bounds it anyway.
 *
 * The live bus is best-effort: a failed subscription degrades the wait to the
 * durable pre-check plus the deadline re-check and is reported as
 * `liveFanout: false` rather than failing the tool.
 */

import type {
  SessionEvent,
  SessionEventSemanticClass,
  SessionEventType,
} from "@opengeni/contracts";
import {
  SESSION_EVENT_SEMANTIC_CLASS_TYPES,
  SESSION_SYSTEM_UPDATE_WAKE_CLASS,
  compactSessionEventResult,
  type SessionSystemUpdateKind,
} from "@opengeni/contracts";
import { SESSION_EVENT_MCP_MAX_BYTES, capPayloadValue } from "./session-view";

export const SESSION_WAIT_MAX_TARGETS = 16;
export const SESSION_WAIT_MAX_SECONDS = 50;
export const SESSION_WAIT_DEFAULT_SECONDS = 45;
/** Newest-first durable rows read per target on every database check. */
export const SESSION_WAIT_EVENTS_PER_TARGET = 20;

/**
 * The durable event types that matter to a waiter: turn lifecycle, completed
 * agent messages, blocking failures, goal facts, and session status/control
 * changes. Raw deltas, tool receipts, sandbox/machine diagnostics, and PTY
 * noise never wake a waiter; `session_events` remains the drill-down for them.
 */
export const SESSION_WAIT_EVENT_TYPES = [
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
  "turn.capacity_waiting",
  "agent.message.completed",
  "session.status.changed",
  "session.requiresAction",
  "session.humanInput.requested",
  "session.control.paused",
  "session.control.resumed",
  "tool.auth_needed",
  "credential.auth_needed",
  "rig.setup.failed",
  "goal.set",
  "goal.updated",
  "goal.progress",
  "goal.rewrite.proposed",
  "goal.rewrite.rejected",
  "goal.completed",
  "goal.paused",
  "goal.resumed",
  "goal.cleared",
  "goal.continuation",
] as const satisfies readonly SessionEventType[];

/**
 * Settlement and blocking events that make a child result usable.
 * Goal facts are deliberately absent: an agent can complete its durable goal
 * before it emits the final assistant message and settles the turn. Completed
 * agent messages are also absent because commentary messages use the same
 * event type; `turn.completed` carries the authoritative final output.
 */
export const SESSION_WAIT_COMPLETION_EVENT_TYPES = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
  "turn.capacity_waiting",
  "session.requiresAction",
  "session.humanInput.requested",
  "session.control.paused",
  "tool.auth_needed",
  "credential.auth_needed",
  "rig.setup.failed",
  "goal.paused",
] as const satisfies readonly SessionEventType[];

/** The self-session event that announces a newly pending machine input. */
export const SESSION_WAIT_OWN_PENDING_EVENT_TYPE =
  "system.update.pending" satisfies SessionEventType;

/**
 * Whether a pending own machine input of this kind ends the wait. Every
 * pre-existing kind and `child_requires_action` are `immediate`; deferred
 * child notices are reported but do not end the wait by themselves.
 */
export function ownPendingKindWakes(kind: string): boolean {
  const wakeClass = SESSION_SYSTEM_UPDATE_WAKE_CLASS[kind as SessionSystemUpdateKind];
  return wakeClass === undefined || wakeClass === "immediate";
}

const SEMANTIC_CLASS_PRIORITY: readonly SessionEventSemanticClass[] = [
  "terminal",
  "failure",
  "control",
  "checkpoint",
  "tool_receipt",
  "provider_account",
];

export function sessionWaitSemanticClass(type: SessionEventType): SessionEventSemanticClass {
  for (const semanticClass of SEMANTIC_CLASS_PRIORITY) {
    const types: readonly SessionEventType[] = SESSION_EVENT_SEMANTIC_CLASS_TYPES[semanticClass];
    if (types.includes(type)) return semanticClass;
  }
  return "control";
}

export type SessionWaitTarget = { sessionId: string; afterSequence: number };

export type SessionWaitEventSummary = {
  id: string;
  sequence: number;
  type: SessionEventType;
  occurredAt: string;
  turnId: string | null;
  turnGeneration: number | null;
  status: string;
  text: string | null;
  failure: {
    error: string | null;
    code: string | null;
    retryable: boolean | null;
    recovery: string | null;
  } | null;
  result?: unknown;
};

export type SessionWaitTargetResult = {
  sessionId: string;
  afterSequence: number;
  /** Cursor for the next `session_wait`/`session_events after=` call. */
  latestSequence: number;
  hasMore: boolean;
  events: SessionWaitEventSummary[];
};

export type SessionWaitResult = {
  changed: SessionWaitTargetResult[];
  ownPendingUpdates: number;
  ownPendingUpdateKinds: string[];
  /**
   * Pending own inputs whose kind wakes the session by itself (every
   * pre-existing kind plus `child_requires_action`). Only these end the wait;
   * `deferred` child notices (resolution, pause, capacity wait, progress) are
   * reported but keep the wait on the targets.
   */
  ownPendingImmediateUpdates: number;
  ownPendingDeferredUpdateKinds: string[];
  waitedMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** False when at least one live-fanout subscription failed; the wait then relied on the deadline re-check. */
  liveFanout: boolean;
  truncated: boolean;
  bytes: number;
  maxBytes: number;
};

export type SessionWaitTargetRead = { events: readonly SessionEvent[]; hasMore: boolean };

export type SessionWaitSource = {
  /** Durable forward read of matching events strictly after the target cursor. */
  readTargetEvents: (target: SessionWaitTarget) => Promise<SessionWaitTargetRead>;
  /** Kinds of the caller's own pending machine inputs; null disables self tracking. */
  readOwnPendingUpdateKinds: (() => Promise<readonly string[]>) | null;
  /** Live fanout subscription for one session; the returned function unsubscribes. */
  subscribe: (
    sessionId: string,
    onEvents: (events: SessionEvent[]) => void | Promise<void>,
  ) => Promise<() => void>;
  /**
   * Re-run target authorization for the sessions about to be returned after a
   * wait (parity with SSE re-authorization). Throws to refuse the result.
   */
  reauthorizeTargets?: ((sessionIds: readonly string[]) => Promise<void>) | undefined;
};

export type SessionWaitInput = {
  targets: readonly SessionWaitTarget[];
  ownSessionId: string | null;
  maxWaitMs: number;
  /** Target events that end the wait. Defaults to the ordinary activity set. */
  targetEventTypes?: readonly SessionEventType[] | undefined;
  source: SessionWaitSource;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  maxBytes?: number | undefined;
};

type WakeReason = "bus" | "deadline" | "abort";

export async function waitForSessionChanges(input: SessionWaitInput): Promise<SessionWaitResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  // The cap is enforced here as well as in the tool schema: no caller can hold
  // the API past the worker's 60 s MCP request timeout.
  const deadlineAt =
    startedAt + Math.min(Math.max(0, input.maxWaitMs), SESSION_WAIT_MAX_SECONDS * 1_000);
  let liveFanout = true;
  let waited = false;
  const ownSessionId = input.source.readOwnPendingUpdateKinds ? input.ownSessionId : null;
  const targetEventTypeSet: ReadonlySet<string> = new Set(
    input.targetEventTypes ?? SESSION_WAIT_EVENT_TYPES,
  );

  // One subscription per distinct session; a session may be both a target and
  // the caller's own session, in which case either condition wakes the wait.
  const targetAfter = new Map<string, number>();
  for (const target of input.targets) {
    const existing = targetAfter.get(target.sessionId);
    targetAfter.set(
      target.sessionId,
      existing === undefined ? target.afterSequence : Math.min(existing, target.afterSequence),
    );
  }
  const subscribedSessionIds = new Set<string>(targetAfter.keys());
  if (ownSessionId !== null) subscribedSessionIds.add(ownSessionId);

  let wake: (() => void) | null = null;
  let wakePending = false;
  const signalWake = () => {
    wakePending = true;
    wake?.();
  };
  const matchesWake = (sessionId: string, events: SessionEvent[]): boolean => {
    const after = targetAfter.get(sessionId);
    for (const event of events) {
      if (event.sessionId !== sessionId) continue;
      if (after !== undefined && event.sequence > after && targetEventTypeSet.has(event.type)) {
        return true;
      }
      if (sessionId === ownSessionId && event.type === SESSION_WAIT_OWN_PENDING_EVENT_TYPE) {
        return true;
      }
    }
    return false;
  };

  const unsubscribes: Array<() => void> = [];
  const release = () => {
    for (const unsubscribe of unsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Releasing a live-fanout subscription is best-effort; the durable
        // read already decided the result.
      }
    }
  };

  const readAll = async (): Promise<{
    changed: SessionWaitTargetResult[];
    ownPendingUpdateKinds: string[];
  }> => {
    const [targetReads, ownKinds] = await Promise.all([
      Promise.all(
        input.targets.map(async (target) => ({
          target,
          read: await input.source.readTargetEvents(target),
        })),
      ),
      input.source.readOwnPendingUpdateKinds
        ? input.source.readOwnPendingUpdateKinds()
        : Promise.resolve([] as readonly string[]),
    ]);
    const changed: SessionWaitTargetResult[] = [];
    for (const { target, read } of targetReads) {
      const events = read.events.filter(
        (event) => event.sequence > target.afterSequence && targetEventTypeSet.has(event.type),
      );
      if (events.length === 0) continue;
      changed.push({
        sessionId: target.sessionId,
        afterSequence: target.afterSequence,
        latestSequence: events[events.length - 1]!.sequence,
        hasMore: read.hasMore,
        events: events.map((event) => summarizeSessionWaitEvent(event)),
      });
    }
    return { changed, ownPendingUpdateKinds: [...ownKinds] };
  };

  const finish = async (
    read: { changed: SessionWaitTargetResult[]; ownPendingUpdateKinds: string[] },
    outcome: { timedOut: boolean; aborted: boolean },
  ): Promise<SessionWaitResult> => {
    // Authorization ran immediately before the first durable read; a result
    // produced after waiting re-proves every returned target first.
    if (waited && read.changed.length > 0 && input.source.reauthorizeTargets) {
      await input.source.reauthorizeTargets(read.changed.map((target) => target.sessionId));
    }
    const ownKinds = [...new Set(read.ownPendingUpdateKinds)].sort();
    return boundSessionWaitResult(
      {
        changed: read.changed,
        ownPendingUpdates: read.ownPendingUpdateKinds.length,
        ownPendingUpdateKinds: ownKinds,
        ownPendingImmediateUpdates: read.ownPendingUpdateKinds.filter((kind) =>
          ownPendingKindWakes(kind),
        ).length,
        ownPendingDeferredUpdateKinds: ownKinds.filter((kind) => !ownPendingKindWakes(kind)),
        waitedMs: Math.max(0, now() - startedAt),
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        liveFanout,
      },
      input.maxBytes,
    );
  };

  try {
    if (input.signal?.aborted) {
      return await finish(
        { changed: [], ownPendingUpdateKinds: [] },
        { timedOut: false, aborted: true },
      );
    }
    // Subscribe first, then read: an event committed between the read and the
    // subscription would otherwise be missed until the deadline re-check. A
    // failed subscription degrades to pre-check plus deadline re-check.
    for (const sessionId of subscribedSessionIds) {
      try {
        const unsubscribe = await input.source.subscribe(sessionId, (events) => {
          if (matchesWake(sessionId, events)) signalWake();
        });
        unsubscribes.push(unsubscribe);
      } catch {
        liveFanout = false;
      }
      if (input.signal?.aborted) break;
    }

    for (;;) {
      if (input.signal?.aborted) {
        return await finish(
          { changed: [], ownPendingUpdateKinds: [] },
          { timedOut: false, aborted: true },
        );
      }
      wakePending = false;
      const read = await readAll();
      if (
        read.changed.length > 0 ||
        read.ownPendingUpdateKinds.some((kind) => ownPendingKindWakes(kind))
      ) {
        return await finish(read, { timedOut: false, aborted: false });
      }
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) {
        return await finish(read, { timedOut: true, aborted: false });
      }
      if (wakePending) continue;
      const reason = await waitForWake(remainingMs, input.signal, (resolve) => {
        wake = resolve;
      });
      wake = null;
      waited = true;
      if (reason === "abort") {
        return await finish(
          { changed: [], ownPendingUpdateKinds: [] },
          { timedOut: false, aborted: true },
        );
      }
      // "bus" and "deadline" both re-read durable state; the deadline branch is
      // the final re-check that covers any lost live fanout.
    }
  } finally {
    wake = null;
    release();
  }
}

function waitForWake(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  registerWake: (wake: () => void) => void,
): Promise<WakeReason> {
  return new Promise<WakeReason>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => settle("abort");
    const settle = (reason: WakeReason) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(reason);
    };
    registerWake(() => settle("bus"));
    timer = setTimeout(() => settle("deadline"), Math.max(1, Math.ceil(timeoutMs)));
    if (signal) {
      if (signal.aborted) {
        settle("abort");
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

const SUMMARY_TEXT_TIERS = [2_000, 800, 200] as const;
const SUMMARY_FAILURE_CHARS = 500;
const SUMMARY_RESULT_CHARS = 1_000;

function truncationMarker(droppedChars: number): string {
  return `…[${droppedChars} chars omitted from this session_wait summary; use session_events for the exact event]`;
}

function clampSummaryString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const dropped = value.length - maxChars;
  const headChars = Math.max(0, Math.floor(maxChars * 0.7));
  const tailChars = Math.max(0, maxChars - headChars);
  const tail = tailChars > 0 ? value.slice(value.length - tailChars) : "";
  return `${value.slice(0, headChars)}${truncationMarker(dropped)}${tail}`;
}

/** One bounded, result-bearing summary of a durable event for a waiter. */
export function summarizeSessionWaitEvent(
  event: SessionEvent,
  textChars: number = SUMMARY_TEXT_TIERS[0],
): SessionWaitEventSummary {
  const compact = compactSessionEventResult(event, sessionWaitSemanticClass(event.type));
  const text = compact.text === null ? null : clampSummaryString(compact.text, textChars);
  const failure =
    compact.failure === null
      ? null
      : {
          error:
            compact.failure.error === null
              ? null
              : clampSummaryString(compact.failure.error, SUMMARY_FAILURE_CHARS),
          code:
            compact.failure.code === null ? null : clampSummaryString(compact.failure.code, 128),
          retryable: compact.failure.retryable,
          recovery:
            compact.failure.recovery === null
              ? null
              : clampSummaryString(compact.failure.recovery, SUMMARY_FAILURE_CHARS),
        };
  const summary: SessionWaitEventSummary = {
    id: compact.id,
    sequence: compact.sequence,
    type: compact.type,
    occurredAt: compact.occurredAt,
    turnId: compact.turnId,
    turnGeneration: compact.turnGeneration,
    status: compact.status,
    text,
    failure,
  };
  // `result` repeats `text` for plain message/completion events; only carry a
  // distinct structured result so the summary stays small.
  if (
    compact.result !== null &&
    compact.result !== undefined &&
    compact.result !== compact.text &&
    typeof compact.result !== "string"
  ) {
    summary.result = capPayloadValue(compact.result, SUMMARY_RESULT_CHARS);
  } else if (typeof compact.result === "string" && compact.result !== compact.text) {
    summary.result = clampSummaryString(compact.result, textChars);
  }
  return summary;
}

function prettyJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function measure(result: SessionWaitResult): SessionWaitResult {
  let measured = result.bytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    result.bytes = measured;
    const next = prettyJsonBytes(result);
    if (next === measured) return result;
    measured = next;
  }
  result.bytes = measured;
  return result;
}

/**
 * Keep the whole model-visible result at or below the `session_events` MCP
 * envelope. Text is tightened first; only then are newest rows dropped from the
 * largest target, which keeps each target's `latestSequence` an exact cursor
 * for the rows actually delivered and marks the remainder as `hasMore`.
 */
export function boundSessionWaitResult(
  input: Omit<SessionWaitResult, "truncated" | "bytes" | "maxBytes">,
  maxBytes: number = SESSION_EVENT_MCP_MAX_BYTES,
): SessionWaitResult {
  const envelopeMaxBytes = Math.max(8 * 1024, maxBytes);
  const build = (changed: SessionWaitTargetResult[], truncated: boolean): SessionWaitResult =>
    measure({
      ...input,
      changed,
      truncated,
      bytes: 0,
      maxBytes: envelopeMaxBytes,
    });

  let candidate = build(input.changed, false);
  if (candidate.bytes <= envelopeMaxBytes) return candidate;

  // Tier 1: tighten text on every summary. Summaries carry their source id and
  // sequence, so a tighter projection loses no identity.
  const retextured = (textChars: number): SessionWaitTargetResult[] =>
    input.changed.map((target) => ({
      ...target,
      events: target.events.map((event) => ({
        ...event,
        text: event.text === null ? null : clampSummaryString(event.text, textChars),
        ...(typeof event.result === "string"
          ? { result: clampSummaryString(event.result, textChars) }
          : {}),
      })),
    }));
  let changed = input.changed;
  for (const textChars of SUMMARY_TEXT_TIERS.slice(1)) {
    changed = retextured(textChars);
    candidate = build(changed, true);
    if (candidate.bytes <= envelopeMaxBytes) return candidate;
  }

  // Tier 2: drop newest rows from the largest target until the envelope fits.
  const working = changed.map((target) => ({ ...target, events: [...target.events] }));
  for (;;) {
    let largest: (typeof working)[number] | null = null;
    for (const target of working) {
      if (target.events.length === 0) continue;
      if (largest === null || target.events.length > largest.events.length) largest = target;
    }
    if (largest === null) break;
    largest.events.pop();
    largest.hasMore = true;
    largest.latestSequence =
      largest.events.length > 0
        ? largest.events[largest.events.length - 1]!.sequence
        : largest.afterSequence;
    candidate = build(working, true);
    if (candidate.bytes <= envelopeMaxBytes) return candidate;
  }
  throw new RangeError(`session_wait result exceeds its ${envelopeMaxBytes}-byte envelope`);
}
