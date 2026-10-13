// Per-task usage limits in the console: whether the server offers them, the
// dollar input, save-error wording, and one shared read of a task's limit so
// the composer notice and the Agent tab never disagree.
//
// Amounts are API-equivalent model usage in USD micros (a list-price
// estimate), not the bill. The server enforces the limit before each model
// request; nothing here is needed for enforcement, it only keeps the view
// fresh.
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  formatSessionUsageMicros,
  SESSION_USAGE_LIMIT_GOAL_PAUSED_REASON,
  SESSION_USAGE_LIMIT_SEGMENT,
  type SessionUsageLimit,
} from "@opengeni/sdk/session-usage-limits";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { apiErrorFacts, userErrorText } from "@/lib/api-error";
import { parseDollars } from "@/lib/usage-allowances";
import type { ClientConfig, SessionEvent } from "@/types";

/**
 * - `absent`: an older server. Hide the feature and never send a limit.
 * - `disabled`: the server turned new limits off. Show existing state and
 *   allow only removing a limit.
 * - `enabled`: the full editor.
 */
export type SessionUsageLimitCapability = "absent" | "disabled" | "enabled";

export function sessionUsageLimitCapability(
  config: Pick<ClientConfig, "sessionUsageLimits"> | null | undefined,
): SessionUsageLimitCapability {
  const advertised = config?.sessionUsageLimits;
  if (!advertised) return "absent";
  return advertised.enabled ? "enabled" : "disabled";
}

/** A limit being chosen: none, or an amount typed in dollars. */
export type SessionUsageLimitDraft = { kind: "none" } | { kind: "limit"; text: string };

export const NO_SESSION_USAGE_LIMIT: SessionUsageLimitDraft = { kind: "none" };

export type ParsedSessionUsageLimitDraft =
  | { ok: true; limitMicros: number | null }
  | { ok: false; error: string };

export const USAGE_LIMIT_AMOUNT_REQUIRED = "Enter an amount in US dollars, like 25.";
export const USAGE_LIMIT_AMOUNT_INVALID =
  "Enter dollars with up to 2 decimals, at most $10,000,000.";

/** The draft as the request's `limitMicros` (null for no limit), or why it can't be sent. */
export function parseSessionUsageLimitDraft(
  draft: SessionUsageLimitDraft,
): ParsedSessionUsageLimitDraft {
  if (draft.kind === "none") return { ok: true, limitMicros: null };
  if (!draft.text.trim()) return { ok: false, error: USAGE_LIMIT_AMOUNT_REQUIRED };
  const micros = parseDollars(draft.text);
  return micros === null
    ? { ok: false, error: USAGE_LIMIT_AMOUNT_INVALID }
    : { ok: true, limitMicros: micros };
}

/** The right-hand value of the new-chat "Usage limit" row. */
export function sessionUsageLimitDraftSummary(draft: SessionUsageLimitDraft): string {
  const parsed = parseSessionUsageLimitDraft(draft);
  if (!parsed.ok) return "Enter amount";
  return parsed.limitMicros === null ? "No limit" : formatSessionUsageMicros(parsed.limitMicros);
}

/** Plain dollars for the amount input ("50", "12.5"), no symbol or grouping. */
export function sessionUsageLimitInputValue(micros: number): string {
  const dollars = micros / 1_000_000;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

export type SessionUsageLimitSaveFailure = {
  kind:
    | "conflict"
    | "preparing"
    | "not_root"
    | "forbidden"
    | "disabled"
    | "unavailable"
    | "invalid"
    | "other";
  message: string;
  /** For `not_root`: the task that owns the limit. */
  rootSessionId?: string;
};

function detailsOf(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

/** What a failed save means, in words, from the response's `details.code`. */
export function classifySessionUsageLimitSaveError(error: unknown): SessionUsageLimitSaveFailure {
  const facts = apiErrorFacts(error);
  const details = detailsOf(error);
  const code = typeof details?.code === "string" ? details.code : facts.code;
  switch (code) {
    case "session_usage_limit_conflict":
      return {
        kind: "conflict",
        message:
          "Someone changed this limit while you were editing. Check the current limit, then save again.",
      };
    case "session_usage_limit_preparing":
      return {
        kind: "preparing",
        message:
          "Earlier usage is still being counted. Save again in a moment; your amount is kept.",
      };
    case "session_usage_limit_not_root":
      return {
        kind: "not_root",
        message: "This chat uses its main task's limit. Change it from the main task.",
        ...(typeof details?.rootSessionId === "string"
          ? { rootSessionId: details.rootSessionId }
          : {}),
      };
    case "session_usage_limit_forbidden":
      return {
        kind: "forbidden",
        message: "Changing the limit needs permission to run this chat.",
      };
    case "session_usage_limit_disabled":
      return {
        kind: "disabled",
        message: "New limits are turned off here. You can still remove a limit.",
      };
    case "session_usage_limit_unavailable":
      return {
        kind: "unavailable",
        message: "Couldn't read this chat's usage right now. Try again in a moment.",
      };
    default:
      break;
  }
  if (facts.status === 403) {
    return { kind: "forbidden", message: "Changing the limit needs permission to run this chat." };
  }
  if (facts.status === 400 || facts.status === 422) {
    return { kind: "invalid", message: USAGE_LIMIT_AMOUNT_INVALID };
  }
  return { kind: "other", message: userErrorText(error, "Couldn't save the limit. Try again.") };
}

/* ----------------------------------------------------------------------------
   Opening the editor. The header's overflow menu and the composer notice ask
   for it without owning the Agent tab: the session route listens and opens
   the tab at Usage limit.
   -------------------------------------------------------------------------- */

export const OPEN_SESSION_USAGE_LIMIT_EVENT = "opengeni:open-session-usage-limit";

export function requestSessionUsageLimitEditor(): void {
  document.dispatchEvent(new Event(OPEN_SESSION_USAGE_LIMIT_EVENT));
}

/* ----------------------------------------------------------------------------
   One shared read per task.
   -------------------------------------------------------------------------- */

/** Any agent in the task tree is running: keep the usage view fresh. */
export function lineageHasRunningSession(
  nodes: ReadonlyArray<{ session: { status: string }; children: ReadonlyArray<unknown> }>,
): boolean {
  return nodes.some(
    (node) =>
      node.session.status === "running" ||
      lineageHasRunningSession(
        node.children as ReadonlyArray<{
          session: { status: string };
          children: ReadonlyArray<unknown>;
        }>,
      ),
  );
}

export type SessionUsageLimitRefusalAmounts = {
  rootSessionId: string;
  limitMicros: number;
  usedMicros: number;
};

/**
 * What a refused Send says until the reread projection answers: the typed
 * refusal's amounts when the error carries them, otherwise the last known
 * limit (the server only refuses at or over it). Null when nothing is
 * pending, or nothing is known to show.
 */
export function usageLimitRefusalFromState(input: {
  pending: boolean;
  error: { rootSessionId?: string; limitMicros?: number; usedMicros?: number } | null;
  usage: SessionUsageLimit | null;
}): SessionUsageLimitRefusalAmounts | null {
  const { error, usage } = input;
  if (!input.pending) return null;
  if (error && typeof error.limitMicros === "number" && typeof error.usedMicros === "number") {
    return {
      rootSessionId: error.rootSessionId ?? usage?.rootSessionId ?? "",
      limitMicros: error.limitMicros,
      usedMicros: error.usedMicros,
    };
  }
  if (!usage || usage.limitMicros === null) return null;
  return {
    rootSessionId: usage.rootSessionId,
    limitMicros: usage.limitMicros,
    usedMicros: Math.max(usage.usedMicros ?? usage.limitMicros, usage.limitMicros),
  };
}

type UsageLimitClient = Pick<OpenGeniBrowserClient, "getSessionUsageLimit">;

export type SessionUsageLimitSnapshot = {
  usage: SessionUsageLimit | null;
  /** The last read failed (the last good value, if any, stays). */
  error: unknown;
  loading: boolean;
};

type Entry = {
  snapshot: SessionUsageLimitSnapshot;
  inflight: Promise<SessionUsageLimit | null> | null;
  listeners: Set<() => void>;
};

const EMPTY: SessionUsageLimitSnapshot = { usage: null, error: null, loading: false };
const entriesByClient = new WeakMap<object, Map<string, Entry>>();

function entryFor(client: object, key: string): Entry {
  let entries = entriesByClient.get(client);
  if (!entries) {
    entries = new Map();
    entriesByClient.set(client, entries);
  }
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: EMPTY, inflight: null, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, next: Partial<SessionUsageLimitSnapshot>): void {
  entry.snapshot = { ...entry.snapshot, ...next };
  for (const listener of entry.listeners) listener();
}

/** A newer projection wins; an older read never replaces a fresher save. */
function newer(current: SessionUsageLimit | null, next: SessionUsageLimit): boolean {
  if (!current || current.rootSessionId !== next.rootSessionId) return true;
  if (next.version !== current.version) return next.version > current.version;
  return next.usageRevision >= current.usageRevision;
}

function applyUsage(entry: Entry, usage: SessionUsageLimit): void {
  if (newer(entry.snapshot.usage, usage)) publish(entry, { usage, error: null });
  else publish(entry, { error: null });
}

async function readUsage(
  client: UsageLimitClient,
  workspaceId: string,
  sessionId: string,
): Promise<SessionUsageLimit | null> {
  const entry = entryFor(client, `${workspaceId}/${sessionId}`);
  if (entry.inflight) return await entry.inflight;
  publish(entry, { loading: true });
  const request = client
    .getSessionUsageLimit(workspaceId, sessionId)
    .then((usage) => {
      applyUsage(entry, usage);
      return entry.snapshot.usage;
    })
    .catch((error: unknown) => {
      publish(entry, { error });
      return entry.snapshot.usage;
    })
    .finally(() => {
      entry.inflight = null;
      publish(entry, { loading: false });
    });
  entry.inflight = request;
  return await request;
}

/** Events on the task's own stream that can change its usage or limit. */
export function isSessionUsageLimitRefreshEvent(event: SessionEvent): boolean {
  if (
    event.type === "session.usage_limit.updated" ||
    event.type === "agent.model.usage" ||
    event.type === "goal.paused"
  ) {
    return true;
  }
  if (event.type !== "turn.completed") return false;
  const payload = event.payload as { segmentLimit?: unknown } | null | undefined;
  return payload?.segmentLimit === SESSION_USAGE_LIMIT_SEGMENT;
}

/**
 * The goal is paused at the usage limit right now: the newest goal event in
 * the loaded stream is that pause. Raising the limit never resumes it.
 */
export function goalPausedAtUsageLimit(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!event.type.startsWith("goal.")) continue;
    if (event.type !== "goal.paused") return false;
    // `goal.paused` carries the reason as `reason` (the goal record calls it `pausedReason`).
    const payload = event.payload as { reason?: unknown; pausedReason?: unknown } | null;
    return (
      payload?.reason === SESSION_USAGE_LIMIT_GOAL_PAUSED_REASON ||
      payload?.pausedReason === SESSION_USAGE_LIMIT_GOAL_PAUSED_REASON
    );
  }
  return false;
}

/** Wait after a burst of usage events before reading, so one turn is one read. */
export const SESSION_USAGE_LIMIT_EVENT_DEBOUNCE_MS = 1_000;
/** At most this often while a visible task tree is running. */
export const SESSION_USAGE_LIMIT_POLL_MS = 30_000;

export type UseSessionUsageLimitOptions = {
  client: UsageLimitClient;
  workspaceId: string;
  sessionId: string;
  /** `session.usageLimit` from the detail read, until the first GET answers. */
  initial?: SessionUsageLimit | null | undefined;
  /** False when the server doesn't offer limits: never read. */
  enabled: boolean;
  /**
   * Only the one owner of the live stream passes these: it reads on relevant
   * events, polls while the task tree is active and visible, and rereads on
   * focus and reconnect. Other views share what it reads.
   */
  live?: {
    events: readonly SessionEvent[];
    /** The session or one of its agents is running. */
    active: boolean;
    connectionState?: string;
  };
};

export type SessionUsageLimitState = SessionUsageLimitSnapshot & {
  refresh: () => Promise<SessionUsageLimit | null>;
  /** Show a saved projection right away (the PUT response). */
  apply: (usage: SessionUsageLimit) => void;
};

export function useSessionUsageLimit(options: UseSessionUsageLimitOptions): SessionUsageLimitState {
  const { client, workspaceId, sessionId, enabled, initial, live } = options;
  const key = `${workspaceId}/${sessionId}`;
  const entry = entryFor(client, key);
  if (enabled && initial && !entry.snapshot.usage) {
    // Seed without notifying: this render already reads it.
    entry.snapshot = { ...entry.snapshot, usage: initial };
  }
  const subscribe = useCallback(
    (listener: () => void) => {
      const current = entryFor(client, key);
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    [client, key],
  );
  const getSnapshot = useCallback(
    () => (enabled ? entryFor(client, key).snapshot : EMPTY),
    [client, enabled, key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(
    async () => (enabled ? await readUsage(client, workspaceId, sessionId) : null),
    [client, enabled, sessionId, workspaceId],
  );
  const apply = useCallback(
    (usage: SessionUsageLimit) => applyUsage(entryFor(client, key), usage),
    [client, key],
  );

  const driving = enabled && live !== undefined;
  // First read on mount (and when the task changes).
  useEffect(() => {
    if (!driving) return;
    void refresh();
  }, [driving, refresh]);

  // Debounced read after new relevant events; history already loaded is the baseline.
  const events = live?.events;
  const lastRelevant = useRef<{ key: string; sequence: number } | null>(null);
  let newestRelevant = 0;
  if (events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (isSessionUsageLimitRefreshEvent(event)) {
        newestRelevant = event.sequence;
        break;
      }
    }
  }
  useEffect(() => {
    if (!driving) return;
    const previous = lastRelevant.current;
    lastRelevant.current = { key, sequence: newestRelevant };
    if (!previous || previous.key !== key || newestRelevant <= previous.sequence) return;
    const timer = window.setTimeout(() => void refresh(), SESSION_USAGE_LIMIT_EVENT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [driving, key, newestRelevant, refresh]);

  // Foreground poll while the task tree is active.
  const active = live?.active === true;
  useEffect(() => {
    if (!driving || !active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, SESSION_USAGE_LIMIT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, driving, refresh]);

  // Back to the tab: read once.
  useEffect(() => {
    if (!driving) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [driving, refresh]);

  // Reconnected after a drop: read once.
  const connectionState = live?.connectionState;
  const previousConnection = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connectionState;
    if (!driving || connectionState !== "live" || previous === undefined || previous === "live") {
      return;
    }
    void refresh();
  }, [connectionState, driving, refresh]);

  return { ...snapshot, refresh, apply };
}
