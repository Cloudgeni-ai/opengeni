/** Bounded diagnostic text, never authority to retry a provider effect. */
export const DIAGNOSTIC_BYTES = 8192;
const phases = new WeakMap<object, string>();
export function markFailurePhase(error: unknown, phase: string) {
  if (error && typeof error === "object" && !phases.has(error)) phases.set(error, phase);
  return error;
}
export function redactDiagnostic(
  text: string,
  env: Record<string, string | undefined> = process.env,
  limit = DIAGNOSTIC_BYTES,
): string {
  let clean = text;
  for (const [key, value] of Object.entries(env)) {
    if (
      value &&
      value.length >= 4 &&
      /token|secret|password|credential|private.key|authorization/i.test(key)
    ) {
      for (const secret of [value, ...value.split(/\r?\n/).filter((v) => v.length >= 16)])
        clean = clean.split(secret).join("[REDACTED]");
    }
  }
  clean = clean
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[REDACTED TOKEN]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, "[REDACTED AUTH]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED JWT]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED URL]")
    .replace(
      /((?:token|secret|password|credential|authorization|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9_=-]{80,}\b/g, "[REDACTED OPAQUE VALUE]")
    .replace(/^[A-Za-z0-9+/=_-]{80,}$/gm, "[REDACTED KEY MATERIAL]");
  return Buffer.from(clean).subarray(0, limit).toString("utf8");
}
export function errorDiagnostic(
  error: unknown,
  env: Record<string, string | undefined> = process.env,
) {
  const e = error as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    operation?: unknown;
    status?: unknown;
  } | null;
  const text = (v: unknown, n: number) => redactDiagnostic(typeof v === "string" ? v : "", env, n);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Non-Error failure";
  const phase = error && typeof error === "object" ? (phases.get(error) ?? "startup") : "startup";
  const unsafe =
    phase === "atomic-push" ||
    /unknown.*outcome|outcome.*unknown|fenc|rules?.*(?:drift|changed|mismatch)|live lease|prepared lease|stale remote ref snapshot|initialization required|never auto-reinitialize/i.test(
      message,
    );
  const result = {
    schema: "batcher-child-failure/v1",
    diagnosticTruncated:
      Buffer.byteLength(message) > 2048 ||
      (typeof e?.stack === "string" && Buffer.byteLength(e.stack) > 4096),
    category: unsafe
      ? "unsafe_controller_failure"
      : typeof e?.status === "number"
        ? "provider_failure"
        : "unclassified_child_failure",
    name: text(e?.name || "Error", 128),
    message: text(message, 2048),
    stack: text(e?.stack, 4096),
    phase: text(phase, 128),
    operation: text(e?.operation, 256),
    httpStatus:
      Number.isInteger(e?.status) && Number(e?.status) >= 100 && Number(e?.status) <= 599
        ? (e!.status as number)
        : null,
  };
  // Keep the entire JSON record inside the supervisor's bounded stderr tail,
  // including JSON escaping of arbitrary diagnostic text.
  while (Buffer.byteLength(JSON.stringify(result)) > 6144) {
    result.diagnosticTruncated = true;
    if (result.stack.length > 128)
      result.stack = result.stack.slice(0, Math.floor(result.stack.length / 2));
    else result.message = result.message.slice(0, Math.floor(result.message.length / 2));
  }
  return result;
}
export type ErrorDiagnostic = ReturnType<typeof errorDiagnostic>;
export function parseErrorDiagnostic(
  line: string,
  env: Record<string, string | undefined> = process.env,
): ErrorDiagnostic | null {
  if (Buffer.byteLength(line) > 32768) return null;
  try {
    const v = JSON.parse(line);
    if (
      v?.schema !== "batcher-child-failure/v1" ||
      !["unsafe_controller_failure", "provider_failure", "unclassified_child_failure"].includes(
        v.category,
      )
    )
      return null;
    const e = new Error(typeof v.message === "string" ? v.message : "Malformed diagnostic");
    e.name = typeof v.name === "string" ? v.name : "Error";
    e.stack = typeof v.stack === "string" ? v.stack : "";
    markFailurePhase(e, typeof v.phase === "string" ? v.phase : "unknown");
    const result = errorDiagnostic(
      Object.assign(e, { operation: v.operation, status: v.httpStatus }),
      env,
    );
    // A child-declared unsafe outcome can only tighten, never relax, the stop.
    if (v.category === "unsafe_controller_failure") result.category = v.category;
    if (v.diagnosticTruncated === true) result.diagnosticTruncated = true;
    return result;
  } catch {
    return null;
  }
}
