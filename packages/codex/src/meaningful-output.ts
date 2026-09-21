/** Conservative progress evidence; reasoning/usage/empty terminal bookkeeping is not work. */
export function hasMeaningfulCodexOutput(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  return output.some((value) => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    if (item.status !== undefined && item.status !== "completed") return false;
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      return item.content.some((part: unknown) => {
        if (!part || typeof part !== "object") return false;
        const content = part as Record<string, unknown>;
        return (
          content.type === "output_text" &&
          typeof content.text === "string" &&
          content.text.trim().length > 0
        );
      });
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const payload = item.type === "function_call" ? item.arguments : item.input;
      return (
        typeof item.name === "string" &&
        item.name.trim().length > 0 &&
        typeof item.call_id === "string" &&
        item.call_id.length > 0 &&
        typeof payload === "string" &&
        payload.trim().length > 0
      );
    }
    return (
      item.type === "image_generation_call" &&
      typeof item.result === "string" &&
      item.result.length > 0
    );
  });
}
