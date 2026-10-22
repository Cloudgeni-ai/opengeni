import { useRef } from "react";
import type { Session, SessionEvent, SessionQueueSnapshot } from "@opengeni/sdk";
import type { ComposerState, TimelineItem } from "../session";
import { useSessionStartupState, type SessionStartupSource } from "./session-startup";

type StartupInput = {
  session: Pick<
    Session,
    | "id"
    | "status"
    | "activeTurnId"
    | "effectiveControl"
    | "dispatchWait"
    | "inputWait"
    | "lastSequence"
    | "queueVersion"
  >;
  events: SessionEvent[];
  optimisticMessages: ComposerState["optimisticMessages"];
  hasNewer: boolean;
  queue?: SessionQueueSnapshot | null | undefined;
  fallbackStartedAt?: string | undefined;
};
function currentEvents(events: SessionEvent[]) {
  return events
    .filter(
      (event) =>
        !event.duplicateOfEventId &&
        (!event.turnAssociation || event.turnAssociation === "current"),
    )
    .sort((a, b) => a.sequence - b.sequence);
}
function payloadOf(event: SessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

/** Presentation only. Accepted work is not proof that a worker is executing. */
export function sessionStartupTimeline(items: TimelineItem[], input: StartupInput): TimelineItem[] {
  const { session, optimisticMessages, hasNewer } = input;
  if (
    hasNewer ||
    session.effectiveControl.state !== "active" ||
    !["idle", "queued", "running"].includes(session.status) ||
    (session.status === "idle" && session.inputWait)
  )
    return items;
  const claimed = new Set<string>();
  const pending = new Map<string, string>();
  let queueVersion = session.queueVersion;
  let newerProgress = false;
  let observedActiveTurn: string | null = null;
  // A prompt that waited behind earlier work starts its queue span when that
  // work ended, not when the person queued it.
  let previousTurnEndedAt: string | null = null;
  for (const event of currentEvents(input.events)) {
    const payload = payloadOf(event);
    if (
      event.turnId &&
      ["turn.completed", "turn.failed", "turn.cancelled", "turn.superseded"].includes(event.type)
    )
      previousTurnEndedAt = event.occurredAt;
    if (
      event.sequence > session.lastSequence &&
      ([
        "turn.started",
        "turn.completed",
        "turn.failed",
        "turn.cancelled",
        "turn.superseded",
      ].includes(event.type) ||
        (event.type === "session.status.changed" && payload.status !== "queued") ||
        (event.type === "session.queue.changed" &&
          ["edit", "delete"].includes(String(payload.operation))))
    )
      newerProgress = true;
    if (event.type === "session.queue.changed" && typeof payload.queueVersion === "number")
      queueVersion = Math.max(queueVersion, payload.queueVersion);
    const turnId = event.turnId ?? (typeof payload.turnId === "string" ? payload.turnId : null);
    if (!turnId) continue;
    if (event.sequence > session.lastSequence) {
      if (event.type === "turn.started") observedActiveTurn = turnId;
      else if (
        observedActiveTurn === turnId &&
        ["turn.completed", "turn.failed", "turn.cancelled", "turn.superseded"].includes(event.type)
      )
        observedActiveTurn = null;
    }
    if (
      [
        "turn.started",
        "turn.completed",
        "turn.failed",
        "turn.cancelled",
        "turn.superseded",
      ].includes(event.type) ||
      (event.type === "session.queue.changed" &&
        ["edit", "delete"].includes(String(payload.operation)))
    )
      claimed.add(turnId);
    if (
      (event.type === "turn.queued" || event.type === "user.message") &&
      payload.routing === "accepted_for_execution" &&
      (session.status !== "idle" || event.sequence > session.lastSequence)
    )
      pending.set(turnId, event.occurredAt);
  }
  for (const message of optimisticMessages ?? []) {
    if (
      message.state === "queued" &&
      message.destination === "chat" &&
      message.delivery === "send" &&
      message.turnId &&
      !pending.has(message.turnId) &&
      (session.status !== "idle" ||
        (message.appliedQueueVersion != null && message.appliedQueueVersion > session.queueVersion))
    )
      pending.set(message.turnId, message.occurredAt);
  }
  // The visible queue excludes the already accepted current message. Only its
  // authoritative first item may become the next startup; replay order is not priority.
  const head = input.queue && input.queue.version >= queueVersion ? input.queue.items[0] : null;
  if (session.status === "queued" && !session.activeTurnId && head && !pending.has(head.id))
    pending.set(
      head.id,
      previousTurnEndedAt && previousTurnEndedAt > head.createdAt
        ? previousTurnEndedAt
        : head.createdAt,
    );
  const candidate = [...pending].find(
    ([turnId]) =>
      !claimed.has(turnId) &&
      (!session.activeTurnId || session.activeTurnId === turnId) &&
      (!observedActiveTurn || observedActiveTurn === turnId) &&
      !items.some((item) => "turnId" in item && item.turnId === turnId),
  );
  const fallback =
    !candidate &&
    !newerProgress &&
    session.status === "queued" &&
    !session.activeTurnId &&
    input.fallbackStartedAt;
  if (!candidate && !fallback) return items;
  const [turnId, startedAt] = candidate ?? [
    `pending-startup:${session.id}`,
    input.fallbackStartedAt!,
  ];
  return [
    ...items,
    {
      kind: "startup-phase",
      id: `${turnId}-queue`,
      turnId,
      phase: "queue",
      status: "running",
      startedAt,
      occurredAt: startedAt,
      completedAt: null,
      durationMs: null,
      outcome: null,
      ...(session.activeTurnId
        ? {}
        : { dispatchWait: session.status === "queued" ? (session.dispatchWait ?? null) : null }),
    },
  ];
}

type Bridge = { scope: string; id: string; turnId: string | null; since: string; sequence: number };

/** A prompt the host already sent while its session is still being created or loaded. */
export type PendingPrompt = {
  /** The prompt exactly as the person sent it. */
  text: string;
  /** When the person sent it (ISO 8601). Anchors the startup row's clock. */
  sentAt: string;
};

const PENDING_SCOPE = "pending-prompt";
/** The startup row keeps this id from the pending prompt through the live projection. */
export const PENDING_PROMPT_STARTUP_ID = "pending-prompt-startup";

function pendingPromptItems(prompt: PendingPrompt): TimelineItem[] {
  return [
    {
      kind: "user-message",
      id: "pending-prompt-message",
      text: prompt.text,
      resources: [],
      tools: [],
      occurredAt: prompt.sentAt,
    },
    {
      kind: "startup-phase",
      id: PENDING_PROMPT_STARTUP_ID,
      turnId: PENDING_SCOPE,
      phase: "queue",
      status: "running",
      startedAt: prompt.sentAt,
      occurredAt: prompt.sentAt,
      completedAt: null,
      durationMs: null,
      outcome: null,
    },
  ];
}
/**
 * Keep the current loading visual while a session-only wake acquires a turn ID.
 * The web app's session page and the embeddable conversation both project
 * through this, so a sent prompt shows the same startup row in either. A
 * session that has not loaded yet leaves the timeline unchanged.
 */
export function useSessionStartupTimeline(
  items: TimelineItem[],
  input: Omit<StartupInput, "fallbackStartedAt" | "session"> & {
    session: (StartupInput["session"] & SessionStartupSource) | null;
    /**
     * A prompt sent before the session or its history is readable. Until
     * `historyReady`, the timeline is that prompt and a running startup row;
     * the live row then keeps the same id and clock, so nothing remounts.
     */
    pendingPrompt?: PendingPrompt | null | undefined;
    historyReady?: boolean | undefined;
  },
): TimelineItem[] {
  const startup = useSessionStartupState(input.session);
  const bridgeRef = useRef<Bridge | null>(null);
  const { pendingPrompt } = input;
  if (pendingPrompt && (!input.session || input.historyReady === false)) {
    bridgeRef.current = {
      scope: PENDING_SCOPE,
      id: PENDING_PROMPT_STARTUP_ID,
      turnId: null,
      since: pendingPrompt.sentAt,
      sequence: 0,
    };
    return [...items, ...pendingPromptItems(pendingPrompt)];
  }
  if (!input.session) {
    bridgeRef.current = null;
    return items;
  }
  const scope = `${input.session.workspaceId}:${input.session.id}`;
  // The pending prompt's row becomes this session's row.
  if (bridgeRef.current?.scope === PENDING_SCOPE)
    bridgeRef.current = { ...bridgeRef.current, scope };
  if (
    bridgeRef.current?.scope !== scope ||
    input.hasNewer ||
    input.session.effectiveControl.state !== "active" ||
    !["queued", "running", "idle"].includes(input.session.status)
  )
    bridgeRef.current = null;
  // A new wake may arrive in the same render as settlement, without an idle
  // frame. Retire the old episode before choosing the next fallback clock.
  const boundTurn = bridgeRef.current?.turnId;
  const settled =
    boundTurn &&
    currentEvents(input.events).find(
      (event) =>
        event.turnId === boundTurn &&
        ["turn.completed", "turn.failed", "turn.cancelled", "turn.superseded"].includes(event.type),
    );
  let fallbackStartedAt =
    bridgeRef.current?.turnId === null ? bridgeRef.current.since : startup?.startedAt;
  if (settled) {
    bridgeRef.current = null;
    fallbackStartedAt =
      input.session.status === "queued" && input.session.lastSequence >= settled.sequence
        ? input.session.updatedAt
        : undefined;
  }
  const projected = sessionStartupTimeline(items, {
    ...input,
    session: input.session,
    fallbackStartedAt,
  });
  if (projected !== items) {
    const phase = projected.at(-1)!;
    if (phase.kind !== "startup-phase") return projected;
    const turnId = phase.turnId === `pending-startup:${input.session.id}` ? null : phase.turnId;
    let bridge = bridgeRef.current;
    if (!bridge || (bridge.turnId && turnId && bridge.turnId !== turnId)) {
      bridge = {
        scope,
        id: phase.id,
        turnId,
        since: phase.startedAt,
        sequence: input.session.lastSequence,
      };
    } else
      bridge = {
        ...bridge,
        turnId: turnId ?? bridge.turnId,
        since: bridge.since < phase.startedAt ? bridge.since : phase.startedAt,
      };
    bridgeRef.current = bridge;
    return [
      ...projected.slice(0, -1),
      { ...phase, id: bridge.id, startedAt: bridge.since, occurredAt: bridge.since },
    ];
  }
  const bridge = bridgeRef.current;
  if (!bridge) return items;
  if (input.session.status === "idle") {
    bridgeRef.current = null;
    return items;
  }
  const started = currentEvents(input.events).find(
    (event) =>
      event.type === "turn.started" &&
      (bridge.turnId ? event.turnId === bridge.turnId : event.sequence > bridge.sequence),
  );
  const turnId = bridge.turnId ?? started?.turnId ?? input.session.activeTurnId;
  const phase = items.find((item) => item.kind === "startup-phase" && item.turnId === turnId);
  if (phase?.kind === "startup-phase") {
    bridgeRef.current = { ...bridge, turnId };
    return items.map((item) =>
      item === phase
        ? {
            ...phase,
            id: bridge.id,
            loadingStartedAt: bridge.since < phase.startedAt ? bridge.since : phase.startedAt,
          }
        : item,
    );
  }
  if (turnId && (started || input.session.activeTurnId === turnId)) {
    bridgeRef.current = { ...bridge, turnId };
    // The claim can arrive before the first preparation receipt. This is a
    // display span for the observed wait, not an event or execution authority.
    return [
      ...items,
      {
        kind: "startup-phase",
        id: bridge.id,
        turnId,
        phase: "queue",
        status: "complete",
        startedAt: bridge.since,
        occurredAt: bridge.since,
        completedAt: started?.occurredAt ?? input.session.updatedAt,
        durationMs: null,
        outcome: null,
      },
    ];
  }
  // An authoritative idle snapshot supersedes acceptance even before SSE catches up.
  if (turnId) bridgeRef.current = null;
  return items;
}
