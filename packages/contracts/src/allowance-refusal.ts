import type { AllowanceExhaustedRefusal } from "./usage-allowances";

const MESSAGE_MAX_UTF8_BYTES = 1_024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Mirror the canonical offset datetime's calendar/time bounds without loading
 * the schema runtime into synchronous browser/React Native session projection.
 * Contract-parity tests guard this deliberately small, bounded wire leaf.
 */
function resetTimestamp(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 64) return false;
  const parts =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** Select only public refusal fields, including from an API error's details.
 * LimitDecision's allowed:false and transport/SQL diagnostics never cross out.
 */
export function parseAllowanceExhaustedRefusal(value: unknown): AllowanceExhaustedRefusal | null {
  const source = record(value);
  if (source?.code !== "allowance_exhausted") return null;
  const fields = record(source.details) ?? source;
  const scope = fields.scope;
  const subjectId = scope === "member" ? fields.subjectId : undefined;
  if (
    typeof source.message !== "string" ||
    (scope !== "workspace" && scope !== "member") ||
    !resetTimestamp(fields.resetsAt) ||
    (subjectId !== undefined &&
      (typeof subjectId !== "string" ||
        subjectId.length === 0 ||
        subjectId.length > 1_024 ||
        subjectId.includes("\0")))
  ) {
    return null;
  }
  const normalized = source.message
    .slice(0, MESSAGE_MAX_UTF8_BYTES * 2)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  const bytes = new TextEncoder().encode(normalized.slice(0, MESSAGE_MAX_UTF8_BYTES * 2));
  let end = Math.min(bytes.length, MESSAGE_MAX_UTF8_BYTES);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    code: "allowance_exhausted",
    scope,
    resetsAt: fields.resetsAt,
    ...(typeof subjectId === "string" ? { subjectId } : {}),
    message: new TextDecoder().decode(bytes.slice(0, end)).trim(),
  };
}

/** Bounded, fixed remedies: a ceiling is not an exhausted billing source.
 * Never interpolate arbitrary exception prose or a member identifier.
 */
export function allowanceExhaustedMessage(refusal: AllowanceExhaustedRefusal): string {
  const remedy =
    refusal.scope === "workspace"
      ? "The workspace usage allowance is exhausted. An organization administrator or a full-access organization API key can raise the workspace ceiling or add an allowance grant."
      : "The member usage allowance is exhausted. A workspace administrator or a full-access organization API key can adjust the member ceiling.";
  const reset =
    refusal.resetsAt === null
      ? "This allowance has no automatic reset."
      : `It resets at ${new Date(refusal.resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC.`;
  return `${remedy} ${reset}`;
}
