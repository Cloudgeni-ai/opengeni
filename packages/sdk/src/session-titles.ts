import type { Session } from "./types";

/**
 * Durable marker used while semantic automatic naming is still pending.
 * Kept local so this browser helper does not retain the larger durable-title
 * sanitizer; the SDK test locks this value to the contracts package marker.
 */
export const AUTOMATIC_SESSION_TITLE_FALLBACK = "New conversation";

const PROMPT_PREVIEW_MAX_WORDS = 10;
const PROMPT_PREVIEW_MAX_CODE_POINTS = 80;
const DEFAULT_IGNORABLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}+/gu;
const OPAQUE_IDENTIFIER_PATTERN =
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/u;
// This display-only gate stays deliberately compact. Durable model-authored
// titles continue through the stricter contracts sanitizer before persistence.
const SENSITIVE_PROMPT_PREVIEW_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S{8,}|\b(?:sk-(?:proj-)?|gh[oprsu]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|[?&](?:access_token|api_key|apikey|password|secret|token)=\S+|\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?(?:key(?:[_-]?id)?|token)|auth[_-]?token|credential(?:s)?|password|passwd|private[_-]?key|secret(?:[_-]?(?:key|token))?|token)\s*[=:]\s*\S+|\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+)/iu;

function deriveOpeningPromptPreview(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const firstLine = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;

  const wordBounded = firstLine
    .replace(/\s+/gu, " ")
    .split(" ")
    .slice(0, PROMPT_PREVIEW_MAX_WORDS)
    .join(" ");
  const codePoints = Array.from(wordBounded);
  let preview = codePoints.slice(0, PROMPT_PREVIEW_MAX_CODE_POINTS).join("");
  if (codePoints.length > PROMPT_PREVIEW_MAX_CODE_POINTS) {
    const lastWhitespace = preview.search(/\s+\S*$/u);
    if (lastWhitespace >= 16) preview = preview.slice(0, lastWhitespace);
  }
  preview = preview.replace(/[\s.!?,;:\-–—]+$/u, "").trim();
  if (!preview) return null;

  const detectionValue = preview.normalize("NFKC").replace(DEFAULT_IGNORABLE_CODE_POINTS, "");
  if (
    SENSITIVE_PROMPT_PREVIEW_PATTERN.test(detectionValue) ||
    OPAQUE_IDENTIFIER_PATTERN.test(detectionValue)
  ) {
    return null;
  }
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
