/**
 * Worker-measured timing of one streamed model call, in whole milliseconds.
 * Stored on the call's `agent.model.usage` event and its `model_call_facts`
 * row so speed (time to first token, duration, output tokens per second) can be
 * analysed later. Every field is null when it was not observed: a call with no
 * streamed text has no time to first text, and a provider that reports no
 * dispatch has no timing at all.
 */
export type ModelCallTiming = {
  /** Opengeni work from SDK model entry (including waiting for the previous
   *  response to settle) to the call's first literal provider dispatch. */
  preDispatchMs: number | null;
  /** First dispatch to the first streamed reasoning or answer fragment. */
  timeToFirstTokenMs: number | null;
  /** First dispatch to the first streamed answer text fragment. */
  timeToFirstTextMs: number | null;
  /** First dispatch to the terminal response, as read by the worker. A call
   *  that needed a transport retry or a provider continuation includes them. */
  durationMs: number | null;
};

const MAX_TIMING_MS = 2_147_483_647;

function timingField(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMING_MS
    ? value
    : null;
}

/**
 * Accept only whole, non-negative millisecond values; anything else becomes
 * null. Timing is observational, so a malformed value never fails a fact.
 */
export function modelCallTimingOrNull(value: unknown): ModelCallTiming | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const timing: ModelCallTiming = {
    preDispatchMs: timingField(record.preDispatchMs),
    timeToFirstTokenMs: timingField(record.timeToFirstTokenMs),
    timeToFirstTextMs: timingField(record.timeToFirstTextMs),
    durationMs: timingField(record.durationMs),
  };
  return Object.values(timing).some((field) => field !== null) ? timing : null;
}

/** The `model_call_facts` columns for a call's timing (all null when absent). */
export function modelCallTimingColumns(timing: ModelCallTiming | null) {
  return {
    preDispatchMs: timing?.preDispatchMs ?? null,
    timeToFirstTokenMs: timing?.timeToFirstTokenMs ?? null,
    timeToFirstTextMs: timing?.timeToFirstTextMs ?? null,
    durationMs: timing?.durationMs ?? null,
  };
}
