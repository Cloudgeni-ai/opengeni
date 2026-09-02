/** Human-authored session titles keep the existing public API ceiling. */
export const SESSION_TITLE_MAX_CHARACTERS = 200;

/**
 * Automatic titles are intentionally much shorter than the manual rename
 * ceiling. This is measured in grapheme clusters so emoji and combining text
 * are never split into malformed display strings.
 */
export const AUTOMATIC_SESSION_TITLE_MAX_GRAPHEMES = 80;

/**
 * Safe durable title used until semantic generation succeeds. It contains no
 * user prompt bytes, so provider failure/offline operation cannot leak a
 * credential or leave a raw prompt prefix in navigation surfaces.
 */
export const AUTOMATIC_SESSION_TITLE_FALLBACK = "New conversation";

// Session creation accepts a body far larger than a navigation label. Bound
// the source before any replace/split/normalization so a persisted large prompt
// cannot amplify memory or CPU on every client render.
const PROMPT_PREVIEW_SCAN_MAX_CODE_UNITS = 4_096;

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

let titleSegmenter: Intl.Segmenter | null | undefined;

const KNOWN_SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:sk-(?:proj-)?|gh[oprsu]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /[?&](?:access_token|api_key|apikey|password|secret|token)=[^\s&#]+/iu,
] as const;

const URI_SCHEME_CANDIDATE_PATTERN = /\b[a-z][a-z0-9+.-]*:\S+/giu;
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-z]:[\\/](?![\\/])[^:]*$/iu;

const SCHEMELESS_HOST_CANDIDATE_PATTERN =
  /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?(?:[/?#][^\s]*)?/giu;

const SCHEMELESS_LOCAL_NETWORK_PATTERNS = [
  /\blocalhost(?:(?::\d{1,5})(?:[/?#][^\s]*)?|[/?#][^\s]*)/iu,
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:(?::\d{1,5})(?:[/?#][^\s]*)?|[/?#][^\s]*)/u,
  /\[(?=[0-9a-f:.]*:[0-9a-f:.]*\])[0-9a-f:.]+\](?:(?::\d{1,5})(?:[/?#][^\s]*)?|[/?#][^\s]*)/iu,
] as const;

const FILE_LIKE_HOST_SUFFIXES = new Set([
  "css",
  "html",
  "js",
  "json",
  "jsx",
  "lock",
  "md",
  "sql",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);

// These authorities are established framework/namespace notation whose exact
// casing is meaningful. Keep this exception deliberately narrow: generic
// PascalCase or uppercase authorities remain host-like because an uppercase
// real domain (for example MICROSOFT.COM/Admin) must not bypass the URL gate.
const DOTTED_TECHNOLOGY_PATH_AUTHORITIES = new Set([
  "ASP.NET",
  "AWS.SDK",
  "Microsoft.Extensions",
  "System.IO",
]);

const SECRET_ASSIGNMENT_CANDIDATE_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:(['"])([A-Za-z][A-Za-z0-9_. -]*)\1|([A-Za-z][A-Za-z0-9_.-]*))\s*[=:]\s*[^\s,;]+/gu;

const SECRET_LABEL_ASSIGNMENT_PATTERN =
  /\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|credential|credentials|password|passwd|private[ _-]?key|secret|token)\b\s*[=:]\s*[^\s,;]+/iu;

const SENSITIVE_ASSIGNMENT_KEY_SUFFIXES = new Set([
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "token",
]);

const COMPACT_SENSITIVE_ASSIGNMENT_KEY_SUFFIXES = [
  "apikey",
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "authtoken",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "secretkey",
  "token",
] as const;

const SENSITIVE_ASSIGNMENT_KEY_WORD_SUFFIXES = [
  ["api", "key"],
  ["access", "key"],
  ["access", "key", "id"],
  ["auth", "key"],
  ["private", "key"],
  ["secret", "key"],
] as const;

function hasWordSuffix(words: readonly string[], suffix: readonly string[]): boolean {
  if (words.length < suffix.length) return false;
  const offset = words.length - suffix.length;
  return suffix.every((word, index) => words[offset + index] === word);
}

function containsSensitiveAssignment(value: string): boolean {
  for (const match of value.matchAll(SECRET_ASSIGNMENT_CANDIDATE_PATTERN)) {
    const key = match[2] ?? match[3];
    if (!key) continue;
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const last = words.at(-1);
    if (last && SENSITIVE_ASSIGNMENT_KEY_SUFFIXES.has(last)) return true;
    if (last && COMPACT_SENSITIVE_ASSIGNMENT_KEY_SUFFIXES.some((suffix) => last.endsWith(suffix))) {
      return true;
    }
    if (SENSITIVE_ASSIGNMENT_KEY_WORD_SUFFIXES.some((suffix) => hasWordSuffix(words, suffix))) {
      return true;
    }
  }
  return false;
}

function containsUriScheme(value: string): boolean {
  for (const match of value.matchAll(URI_SCHEME_CANDIDATE_PATTERN)) {
    // A Windows drive path is the one scheme-shaped token accepted here. Keep
    // the exception exact: one separator after the drive letter and no later
    // colon, so x://host and a nested scheme remain rejected.
    if (!WINDOWS_DRIVE_PATH_PATTERN.test(match[0])) return true;
  }
  return false;
}

function isDottedTechnologyPath(candidate: string): boolean {
  if (/[?:#]/u.test(candidate)) return false;
  const [authority, ...pathSegments] = candidate.split("/");
  if (!authority || pathSegments.length === 0 || pathSegments.some((segment) => !segment)) {
    return false;
  }
  if (
    !DOTTED_TECHNOLOGY_PATH_AUTHORITIES.has(authority) ||
    pathSegments.some((segment) => !/^[A-Z][A-Za-z0-9_-]*$/u.test(segment))
  ) {
    return false;
  }
  return true;
}

function containsSchemelessUrl(value: string): boolean {
  if (SCHEMELESS_LOCAL_NETWORK_PATTERNS.some((pattern) => pattern.test(value))) return true;

  for (const match of value.matchAll(SCHEMELESS_HOST_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    if (candidate.toLowerCase().startsWith("www.")) return true;
    if (!/[/?#]/u.test(candidate)) continue;

    const authority = candidate.split(/[/?#]/u, 1)[0] ?? "";
    const hostname = authority.replace(/:\d{1,5}$/u, "");
    const suffix = hostname.split(".").at(-1)?.toLowerCase();
    if (suffix && FILE_LIKE_HOST_SUFFIXES.has(suffix)) continue;
    if (isDottedTechnologyPath(candidate)) continue;
    return true;
  }
  return false;
}

const OPAQUE_IDENTIFIER_PATTERN =
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/u;

const DEFAULT_IGNORABLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}+/gu;
const ESCAPED_QUOTE_DELIMITERS = /\\+(?=["'])/gu;

const TITLE_LABEL_PATTERN =
  /^(?:(?:suggested|generated|concise)\s+)?(?:(?:session|chat|conversation|task)\s+)?title\s*[:\-–—]\s*/iu;

const LEADING_BOILERPLATE_PATTERNS = [
  /^(?:hi|hello|hey)(?:\s+there)?\s*[,!:.\-–—]*\s*/iu,
  /^(?:i\s+(?:would\s+like|want|need)\s+you\s+to|i['’]d\s+like\s+you\s+to)\s+/iu,
  /^(?:please\s+)?(?:can|could|would|will)\s+you\s+/iu,
  /^(?:your|the)\s+(?:task|job)\s+is\s+to\s+/iu,
  /^(?:please\s+)?help\s+me\s+(?:to\s+)?/iu,
  /^please(?:\s*[,!:.\-–—]+\s*|\s+|$)/iu,
] as const;

function automaticTitleDetectionValue(value: string): string {
  // Detection uses a compatibility-normalized shadow value so fullwidth
  // punctuation/letters, invisible token splits, and serialized quote
  // delimiters cannot evade the policy.
  // The accepted title itself stays byte-for-byte in the user's language and
  // emoji form; this shadow is never returned or persisted.
  return value
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE_CODE_POINTS, "")
    .replace(ESCAPED_QUOTE_DELIMITERS, "");
}

function hasVisibleAutomaticTitleContent(value: string): boolean {
  return automaticTitleDetectionValue(value).trim().length > 0;
}

/**
 * Whether a bounded automatic-title candidate contains a credential, URL, or
 * opaque identifier that must stay out of navigation and other display-title
 * surfaces. Callers handling an unbounded source must bound it before invoking
 * this helper.
 */
export function containsSensitiveAutomaticSessionTitleValue(value: string): boolean {
  const detectionValue = automaticTitleDetectionValue(value);

  if (KNOWN_SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(detectionValue))) return true;
  if (containsUriScheme(detectionValue)) return true;
  if (containsSchemelessUrl(detectionValue)) return true;
  if (SECRET_LABEL_ASSIGNMENT_PATTERN.test(detectionValue)) return true;
  if (containsSensitiveAssignment(detectionValue)) return true;
  if (OPAQUE_IDENTIFIER_PATTERN.test(detectionValue)) return true;
  return false;
}

function stripAutomaticTitleBoilerplate(value: string): string {
  let title = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = title;
    title = title
      .replace(/^(?:```[^\n]*|[\s#>*_`"'“”‘’\-–—]+)+/u, "")
      .replace(TITLE_LABEL_PATTERN, "");
    for (const pattern of LEADING_BOILERPLATE_PATTERNS) {
      title = title.replace(pattern, "");
    }
    title = title.trim();
    if (title === before) break;
  }
  return title;
}

function automaticTitleGraphemes(value: string): string[] {
  if (titleSegmenter === undefined) {
    titleSegmenter =
      typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (titleSegmenter) {
    return Array.from(titleSegmenter.segment(value), (part) => part.segment);
  }

  // Older embedded runtimes may not ship Intl.Segmenter. Preserve surrogate
  // pairs plus common combining/emoji sequences instead of failing module load
  // or slicing UTF-16 code units.
  const graphemes: string[] = [];
  for (const point of value) {
    const prior = graphemes.at(-1);
    if (
      prior &&
      (/^[\p{Mark}\u{FE0E}\u{FE0F}\p{Emoji_Modifier}]$/u.test(point) ||
        point === "\u200d" ||
        prior.endsWith("\u200d"))
    ) {
      graphemes[graphemes.length - 1] = `${prior}${point}`;
    } else {
      graphemes.push(point);
    }
  }
  return graphemes;
}

/** Bound an already-normalized automatic-title candidate without splitting graphemes. */
export function boundAutomaticSessionTitle(value: string): string {
  const words = value.split(/\s+/u);
  const wordBounded = words.length > 10 ? words.slice(0, 10).join(" ") : value;
  const graphemes = automaticTitleGraphemes(wordBounded);
  if (graphemes.length <= AUTOMATIC_SESSION_TITLE_MAX_GRAPHEMES) return wordBounded;

  const prefix = graphemes.slice(0, AUTOMATIC_SESSION_TITLE_MAX_GRAPHEMES).join("");
  const lastWhitespace = prefix.search(/\s+\S*$/u);
  return (lastWhitespace >= 16 ? prefix.slice(0, lastWhitespace) : prefix).trimEnd();
}

/**
 * Normalize a model/system-authored title before it reaches durable session
 * metadata. Human renames intentionally do not use this path.
 *
 * Returns null when the candidate is empty, only boilerplate, or appears to
 * contain a credential/opaque prompt value. Callers should retain the current
 * title (normally {@link AUTOMATIC_SESSION_TITLE_FALLBACK}) in that case.
 */
export function normalizeAutomaticSessionTitle(value: string): string | null {
  const firstLine = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (
    !firstLine ||
    !hasVisibleAutomaticTitleContent(firstLine) ||
    containsSensitiveAutomaticSessionTitleValue(firstLine)
  ) {
    return null;
  }

  let title = stripAutomaticTitleBoilerplate(firstLine)
    .replace(/\s+/gu, " ")
    .replace(/[\s.!?,;:\-–—]+$/u, "")
    .trim();
  if (
    !title ||
    !hasVisibleAutomaticTitleContent(title) ||
    containsSensitiveAutomaticSessionTitleValue(title)
  ) {
    return null;
  }

  title = boundAutomaticSessionTitle(title)
    .replace(/[\s.!?,;:\-–—]+$/u, "")
    .trim();
  if (!title || !hasVisibleAutomaticTitleContent(title)) return null;
  return title;
}

export type SessionDisplayTitleInput = {
  id?: string | null | undefined;
  title?: string | null | undefined;
  titleSource?: "user" | "agent" | null | undefined;
  initialMessage?: string | null | undefined;
  metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type SessionDisplayTitleOptions = {
  /** Optional metadata fields to try before the opening-prompt preview. */
  metadataKeys?: readonly string[] | undefined;
};

/**
 * Derive a bounded, sensitive-safe preview from the opening prompt.
 *
 * Unsafe leading lines are skipped instead of forcing the whole session back
 * to a generic label. This covers prompts that begin with a pasted URL or
 * identifier followed by an ordinary natural-language request on the next
 * line, without putting the rejected value into navigation surfaces.
 */
export function deriveAutomaticSessionTitlePreview(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const lines = value
    .slice(0, PROMPT_PREVIEW_SCAN_MAX_CODE_UNITS)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, "\n")
    .split(/\n+/u);

  for (const candidate of lines) {
    const line = candidate.trim();
    if (!line || containsSensitiveAutomaticSessionTitleValue(line)) continue;

    const preview = boundAutomaticSessionTitle(line.replace(/\s+/gu, " "))
      .replace(/[\s.!?,;:\-–—]+$/u, "")
      .trim();
    if (preview) return preview;
  }

  return null;
}

function automaticSessionReferenceTitle(id: unknown): string {
  const sessionId = typeof id === "string" ? id.trim() : "";
  return SESSION_ID_PATTERN.test(sessionId)
    ? `Conversation ${sessionId.slice(0, 13)}`
    : AUTOMATIC_SESSION_TITLE_FALLBACK;
}

/**
 * Whether the durable title still represents the automatic-title pending state.
 * A user-authored title always wins, even when its literal value is the marker.
 */
export function sessionTitleIsPending(input: SessionDisplayTitleInput): boolean {
  const title = input.title?.trim() ?? "";
  return input.titleSource !== "user" && (!title || title === AUTOMATIC_SESSION_TITLE_FALLBACK);
}

/**
 * Derive the title a human-facing client should display for a session.
 *
 * A semantic agent title or human rename wins. While automatic naming is still
 * pending, clients show a short, sensitive-safe preview of the opening prompt.
 * If no safe prompt text exists, a UUID-derived reference keeps real sessions
 * distinguishable without exposing prompt bytes. The durable pending marker is
 * therefore an internal lifecycle value rather than the ordinary visible name.
 */
export function deriveSessionDisplayTitle(
  input: SessionDisplayTitleInput,
  options: SessionDisplayTitleOptions = {},
): string {
  const title = input.title?.trim() ?? "";
  if (input.titleSource === "user") {
    return title || automaticSessionReferenceTitle(input.id);
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

  return (
    deriveAutomaticSessionTitlePreview(input.initialMessage) ??
    automaticSessionReferenceTitle(input.id)
  );
}
