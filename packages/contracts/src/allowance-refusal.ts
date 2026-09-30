import { AllowanceExhaustedRefusal } from "./usage-allowances";

const MESSAGE_MAX_UTF8_BYTES = 1_024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Select only public refusal fields, including from an API error's details.
 * LimitDecision's allowed:false and transport/SQL diagnostics never cross out.
 */
export function parseAllowanceExhaustedRefusal(value: unknown): AllowanceExhaustedRefusal | null {
  const source = record(value);
  if (source?.code !== "allowance_exhausted") return null;
  const fields = record(source.details) ?? source;
  if (
    typeof source.message !== "string" ||
    (fields.resetsAt !== null &&
      (typeof fields.resetsAt !== "string" ||
        fields.resetsAt.length > 64 ||
        !Number.isFinite(Date.parse(fields.resetsAt))))
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
  const parsed = AllowanceExhaustedRefusal.safeParse({
    code: source.code,
    scope: fields.scope,
    resetsAt: fields.resetsAt,
    ...(fields.scope === "member" && fields.subjectId !== undefined
      ? { subjectId: fields.subjectId }
      : {}),
    message: new TextDecoder().decode(bytes.slice(0, end)).trim(),
  });
  return parsed.success ? parsed.data : null;
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
