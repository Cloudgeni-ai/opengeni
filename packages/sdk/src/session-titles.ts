import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  boundAutomaticSessionTitle,
  containsSensitiveAutomaticSessionTitleValue,
} from "@opengeni/contracts/session-titles";
import type { Session } from "./types";

export { AUTOMATIC_SESSION_TITLE_FALLBACK };

// Session creation accepts a body far larger than a navigation label. Bound
// the source before any replace/split/normalization so a persisted large prompt
// cannot amplify memory or CPU on every browser render.
const PROMPT_PREVIEW_SCAN_MAX_CODE_UNITS = 4_096;

function deriveOpeningPromptPreview(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const firstLine = value
    .slice(0, PROMPT_PREVIEW_SCAN_MAX_CODE_UNITS)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  if (containsSensitiveAutomaticSessionTitleValue(firstLine)) return null;

  const preview = boundAutomaticSessionTitle(firstLine.replace(/\s+/gu, " "))
    .replace(/[\s.!?,;:\-–—]+$/u, "")
    .trim();
  if (!preview) return null;
  return preview;
}

export type SessionDisplayTitleInput = {
  title?: Session["title"] | undefined;
  titleSource?: Session["titleSource"] | undefined;
  initialMessage?: Session["initialMessage"] | null | undefined;
  metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type SessionDisplayTitleOptions = {
  /** Optional metadata fields to try before the opening-prompt preview. */
  metadataKeys?: readonly string[] | undefined;
};

/**
 * Whether the durable title still represents the automatic-title pending state.
 * A user-authored title always wins, even when its literal value is the fallback.
 */
export function sessionTitleIsPending(input: SessionDisplayTitleInput): boolean {
  const title = input.title?.trim() ?? "";
  return input.titleSource !== "user" && (!title || title === AUTOMATIC_SESSION_TITLE_FALLBACK);
}

/**
 * Derive the title a client should display for a session.
 *
 * A semantic agent title or human rename wins. While automatic naming is still
 * pending, clients show a short, sensitive-safe preview of the opening prompt;
 * the preview is never persisted as title metadata and is replaced naturally
 * when `session.title_set` arrives. Obvious credential-, URL-, or identifier-
 * shaped prompt prefixes retain the generic fallback.
 */
export function deriveSessionDisplayTitle(
  input: SessionDisplayTitleInput,
  options: SessionDisplayTitleOptions = {},
): string {
  const title = input.title?.trim() ?? "";
  if (input.titleSource === "user") {
    return title || AUTOMATIC_SESSION_TITLE_FALLBACK;
  }
  if (title && !sessionTitleIsPending(input)) {
    return title;
  }

  for (const key of options.metadataKeys ?? []) {
    const value = input.metadata?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return deriveOpeningPromptPreview(input.initialMessage) ?? AUTOMATIC_SESSION_TITLE_FALLBACK;
}
