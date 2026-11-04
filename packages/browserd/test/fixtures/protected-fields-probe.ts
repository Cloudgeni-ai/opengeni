/**
 * Answers the driver's search for a frame's protected fields (see
 * AgentBrowserDriver.withProtectedFields) for a fake CDP connection: an
 * isolated world, then none found, as Chrome answers for a page without any.
 * Fakes call it first and use its answer when it gives one.
 */
export function protectedFieldsProbeAnswer(
  method: string,
  params: unknown,
): Record<string, unknown> | undefined {
  const record =
    typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  if (method === "Page.createIsolatedWorld" && record.worldName === "opengeni-dom-read") {
    return { executionContextId: 7 };
  }
  if (
    method === "Runtime.evaluate" &&
    String(record.expression).includes("opengeni:protected-fields")
  ) {
    return { result: { type: "object", subtype: "null", value: null } };
  }
  return undefined;
}
