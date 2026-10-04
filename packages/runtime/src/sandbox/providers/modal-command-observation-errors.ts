/** Only used inside a read-only provider RPC boundary. This is deliberately
 * not a Start classifier: remote DNS prose never proves non-dispatch. */
export function isModalCommandObservationTransportError(error: unknown): boolean {
  const seen = new Map<object, boolean>();
  let nodes = 0;
  const own = (value: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !("value" in descriptor)) throw new Error("Unreadable provider error graph");
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 6 || ++nodes > 32) return false;
    if (seen.has(value)) return seen.get(value)!;
    // A cycle sees false until this bounded branch has been fully evaluated.
    seen.set(value, false);
    try {
      const code = own(value, "code");
      const nested: unknown[] = [own(value, "cause"), own(value, "error")].filter(
        (item) => item !== undefined,
      );
      const errors = own(value, "errors");
      if (errors !== undefined) {
        if (!Array.isArray(errors) || !errors.length || errors.length > 16) return false;
        for (let index = 0; index < errors.length; index++) nested.push(own(errors, String(index)));
      }
      if (code !== undefined) {
        const normalized = typeof code === "string" ? code.trim().toUpperCase() : code;
        if (
          ![
            1,
            2,
            4,
            13,
            14,
            "1",
            "2",
            "4",
            "13",
            "14",
            "CANCELLED",
            "UNKNOWN",
            "DEADLINE_EXCEEDED",
            "INTERNAL",
            "UNAVAILABLE",
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "EAI_AGAIN",
            "ENOTFOUND",
          ].includes(normalized as never)
        )
          return false;
        const result = nested.length === 0 || nested.every((item) => visit(item, depth + 1));
        seen.set(value, result);
        return result;
      }
      const result = nested.length > 0 && nested.every((item) => visit(item, depth + 1));
      seen.set(value, result);
      return result;
    } catch {
      return false;
    }
  };
  return visit(error, 0);
}
