import {
  boundClientErrorText,
  scrubClientErrorText,
} from "@opengeni/contracts/client-error-report";
import { errorCauseAttributes, errorCauseMessage } from "@opengeni/observability";

/**
 * What a Better Auth log record may carry to the console. Better Auth logs
 * request bodies, URLs and provider responses as extra arguments (sign-in
 * input, verification and reset links with their tokens, OAuth code and
 * state), so no argument is ever forwarded as is:
 *
 * - an error becomes its reviewed cause classification and its scrubbed,
 *   bounded message (the same projection an unclassified API 500 logs);
 * - a string is scrubbed like an error message (query strings, tokens,
 *   authorization values, secret assignments and email addresses removed)
 *   and bounded;
 * - numbers, booleans, null and undefined pass through;
 * - anything else (objects, arrays, functions) is replaced by its kind.
 *
 * The message itself is scrubbed the same way.
 */
export const BETTER_AUTH_LOG_TEXT_MAX_BYTES = 1_024;
const MAX_LOGGED_ARGUMENTS = 8;
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function betterAuthLogText(text: string): string {
  return boundClientErrorText(
    scrubClientErrorText(text.slice(0, 16_384)).replace(EMAIL_ADDRESS, "[email]"),
    BETTER_AUTH_LOG_TEXT_MAX_BYTES,
  );
}

export function betterAuthLogArgument(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return betterAuthLogText(value);
  if (value instanceof Error) {
    const message = errorCauseMessage(value);
    return {
      ...errorCauseAttributes(value),
      ...(message ? { causeMessage: betterAuthLogText(message) } : {}),
    };
  }
  if (Array.isArray(value)) return "[array]";
  return `[${typeof value}]`;
}

export function betterAuthLogArguments(args: readonly unknown[]): unknown[] {
  const projected = args.slice(0, MAX_LOGGED_ARGUMENTS).map(betterAuthLogArgument);
  if (args.length > MAX_LOGGED_ARGUMENTS) {
    projected.push(`[${args.length - MAX_LOGGED_ARGUMENTS} more]`);
  }
  return projected;
}
