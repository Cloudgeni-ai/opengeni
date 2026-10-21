/**
 * Operator-only context for an interaction driver failure (`driver_failed`):
 * which error class failed and in which function. The controller sends it
 * beside, never inside, the interaction error, so it reaches server logs
 * without changing what a caller or model is shown. Both are code names, never
 * message text.
 */
export type InteractionDriverDiagnostic = {
  errorClass: string;
  /** The innermost named function on the failing stack, when there is one. */
  frame?: string;
};

export const INTERACTION_DRIVER_DIAGNOSTIC_MESSAGE_MAX_CHARS = 200;
const ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const FRAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$<][A-Za-z0-9_$<>]*){0,3}$/;
const STACK_FRAME = /^\s+at\s+(?:async\s+)?(?:new\s+)?([^\s(]+)\s+\(/u;
const REDACTED = "[redacted]";

/** A code identifier, or null for anything that could carry data. */
export function interactionDriverErrorClass(value: unknown): string | null {
  return typeof value === "string" && ERROR_CLASS.test(value) ? value : null;
}

/**
 * A driver-written error message for logs. Such messages are code templates
 * whose variable parts (window titles, page text, paths, URLs, a driver's own
 * free-text reason) are quoted or follow a colon, so this keeps the template
 * head and redacts those parts. Not for arbitrary exception text.
 */
export function redactInteractionDriverMessage(message: string): string {
  const colon = message.search(/:\s/u);
  const head = colon < 0 ? message : message.slice(0, colon);
  const redacted = head
    .replace(/"[^"]*"?|'[^']*'?|`[^`]*`?|“[^”]*”?|‘[^’]*’?|«[^»]*»?/gu, REDACTED)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/giu, REDACTED)
    .replace(/\S*@\S+/gu, REDACTED)
    .replace(/(?:^|\s)(?:~|\.{1,2})?[/\\]\S*/gu, ` ${REDACTED}`)
    .replace(/\b[A-Za-z]:[/\\]\S*/gu, REDACTED)
    .replace(/[^\x20-\x7e]+/gu, REDACTED)
    .replace(/\s+/gu, " ")
    .trim();
  const tail = colon < 0 ? "" : `: ${REDACTED}`;
  const bounded = `${redacted || REDACTED}${tail}`;
  return bounded.length <= INTERACTION_DRIVER_DIAGNOSTIC_MESSAGE_MAX_CHARS
    ? bounded
    : `${bounded.slice(0, INTERACTION_DRIVER_DIAGNOSTIC_MESSAGE_MAX_CHARS - 3)}...`;
}

/** A function name as code, or null for anything else. */
export function interactionDriverFrame(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128 && FRAME.test(value) ? value : null;
}

/** The diagnostic for a thrown value; reads only its name and stack frames. */
export function interactionDriverDiagnostic(error: unknown): InteractionDriverDiagnostic {
  if (!(error instanceof Error)) return { errorClass: "NonError" };
  let name: unknown;
  let stack: unknown;
  try {
    name = error.name !== "Error" ? error.name : error.constructor?.name;
    stack = error.stack;
  } catch {
    /* Untrusted errors contribute only what could be read. */
  }
  let frame: string | null = null;
  if (typeof stack === "string") {
    for (const line of stack.slice(0, 16_384).split("\n")) {
      frame = interactionDriverFrame(STACK_FRAME.exec(line)?.[1]);
      if (frame) break;
    }
  }
  return {
    errorClass: interactionDriverErrorClass(name) ?? "Error",
    ...(frame ? { frame } : {}),
  };
}

/** Validates a diagnostic received from another process. */
export function parseInteractionDriverDiagnostic(
  value: unknown,
): InteractionDriverDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const errorClass = interactionDriverErrorClass(record.errorClass);
  if (errorClass === null) return null;
  const frame = interactionDriverFrame(record.frame);
  return { errorClass, ...(frame ? { frame } : {}) };
}
