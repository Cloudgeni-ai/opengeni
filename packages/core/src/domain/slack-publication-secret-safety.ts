export const SLACK_PUBLICATION_CREDENTIAL_OMISSION = "[credential omitted]";

const CREDENTIAL_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/gi,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})/g,
  /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
] as const;

const BEARER_CREDENTIAL_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(^|[\s,;([])((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token))\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|[^\s,;\])}]{8,})/gi;
const CREDENTIAL_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi;

/**
 * Deterministic, sink-local protection for text that is about to be persisted
 * as a Slack publication projection or rendered to Slack. It intentionally
 * does not scan or mutate canonical Memory, durable-learning receipts, model
 * context, history, events, or any other internal OpenGeni content path.
 */
export function sanitizeSlackPublicationText(value: string): string {
  let sanitized = value;
  for (const pattern of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, SLACK_PUBLICATION_CREDENTIAL_OMISSION);
  }
  sanitized = sanitized.replace(
    BEARER_CREDENTIAL_PATTERN,
    `Bearer ${SLACK_PUBLICATION_CREDENTIAL_OMISSION}`,
  );
  sanitized = sanitized.replace(
    CREDENTIAL_ASSIGNMENT_PATTERN,
    (_match, prefix: string, name: string) =>
      `${prefix}${name}=${SLACK_PUBLICATION_CREDENTIAL_OMISSION}`,
  );
  return sanitized.replace(
    CREDENTIAL_URL_PATTERN,
    (_match, prefix: string) => `${prefix}${SLACK_PUBLICATION_CREDENTIAL_OMISSION}@`,
  );
}
