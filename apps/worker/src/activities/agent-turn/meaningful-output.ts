/**
 * Conservative progress evidence for a model response that reaches the worker
 * as an SDK `response_done` event (providers without their own request
 * events): completed assistant text or a complete function call. Reasoning,
 * usage, an incomplete message and empty bookkeeping are not work. The shared
 * false-resumption breaker of core waiters reads this through
 * `agent.model.request` `meaningfulOutput`.
 */
export function sdkResponseHasMeaningfulOutput(event: unknown): boolean {
  const output = responseDoneOutput(event);
  if (!output) return false;
  return output.some((value) => {
    if (!isRecord(value)) return false;
    if (value.status !== undefined && value.status !== "completed") return false;
    if (value.type === "message" && value.role === "assistant" && Array.isArray(value.content))
      return value.content.some(
        (part) =>
          isRecord(part) &&
          part.type === "output_text" &&
          typeof part.text === "string" &&
          part.text.trim().length > 0,
      );
    return (
      value.type === "function_call" &&
      typeof value.name === "string" &&
      value.name.trim().length > 0 &&
      typeof value.callId === "string" &&
      value.callId.length > 0 &&
      typeof value.arguments === "string" &&
      value.arguments.trim().length > 0
    );
  });
}

function responseDoneOutput(event: unknown): unknown[] | null {
  if (!isRecord(event) || event.type !== "raw_model_stream_event") return null;
  const data = event.data;
  if (!isRecord(data) || data.type !== "response_done" || !isRecord(data.response)) return null;
  return Array.isArray(data.response.output) ? data.response.output : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
