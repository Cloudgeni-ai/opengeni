/** `\{{secret:` inside a JSON string: an escaped reference whose backslash
 * the agent doubled for JSON and the shell splice then halved. `\{` is not a
 * valid JSON escape, so reading it as the literal reference is unambiguous. */
const ESCAPED_SECRET_REFERENCE = /(?<!\\)\\(\{\{secret(?:file)?:)/gu;

export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const repaired = raw.replace(ESCAPED_SECRET_REFERENCE, "$1");
    try {
      if (repaired === raw) throw new Error("unchanged");
      value = JSON.parse(repaired);
    } catch {
      throw new Error(
        raw.includes("{{secret")
          ? "tool arguments must be valid JSON; inside `ogtool call` write a reference as \\{{secret:…}} with one backslash"
          : "tool arguments must be valid JSON",
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}
