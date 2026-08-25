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

let titleSegmenter: Intl.Segmenter | null | undefined;

const KNOWN_SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:sk-(?:proj-)?|gh[oprsu]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\b(?:file|git|https?|ssh):\/\/\S+/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /[?&](?:access_token|api_key|apikey|password|secret|token)=[^\s&#]+/iu,
] as const;

const SECRET_ASSIGNMENT_CANDIDATE_PATTERN =
  /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9_.-]*)\s*[=:]\s*[^\s,;]+/gu;

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

function containsSensitiveAssignment(value: string): boolean {
  for (const match of value.matchAll(SECRET_ASSIGNMENT_CANDIDATE_PATTERN)) {
    const key = match[1];
    if (!key) continue;
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const last = words.at(-1);
    if (last && SENSITIVE_ASSIGNMENT_KEY_SUFFIXES.has(last)) return true;

    const suffix = words.slice(-2).join(" ");
    if (
      suffix === "api key" ||
      suffix === "access token" ||
      suffix === "auth token" ||
      suffix === "private key"
    ) {
      return true;
    }
  }
  return false;
}

const OPAQUE_IDENTIFIER_PATTERN =
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/u;

const DEFAULT_IGNORABLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}+/gu;

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

function containsSensitiveAutomaticTitleValue(value: string): boolean {
  // Detection uses a compatibility-normalized shadow value so fullwidth
  // punctuation/letters and invisible token splits cannot evade the policy.
  // The accepted title itself stays byte-for-byte in the user's language and
  // emoji form; this shadow is never returned or persisted.
  const detectionValue = value.normalize("NFKC").replace(DEFAULT_IGNORABLE_CODE_POINTS, "");

  if (KNOWN_SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(detectionValue))) return true;
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

function boundAutomaticTitle(value: string): string {
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
  if (!firstLine || containsSensitiveAutomaticTitleValue(firstLine)) return null;

  let title = stripAutomaticTitleBoilerplate(firstLine)
    .replace(/\s+/gu, " ")
    .replace(/[\s.!?,;:\-–—]+$/u, "")
    .trim();
  if (!title || containsSensitiveAutomaticTitleValue(title)) return null;

  title = boundAutomaticTitle(title)
    .replace(/[\s.!?,;:\-–—]+$/u, "")
    .trim();
  if (!title) return null;
  return title;
}
