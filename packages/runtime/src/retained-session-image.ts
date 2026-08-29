import type { Tool } from "@openai/agents";

/**
 * `computer_screenshot` is retained only so durable history produced by older
 * OpenGeni releases can still pass through the image-retention boundary.
 * Newly built agents expose managed ComputerSession interaction tools instead.
 */
export type RetainableSessionImageToolName = "view_image" | "computer_screenshot";

export type RetainableSessionImageOutputHook = (input: {
  toolName: RetainableSessionImageToolName;
  toolCallId: string;
  output: unknown;
}) => Promise<void>;

/**
 * Retain an intentional image result before the Agents SDK can add it to live
 * history. The original result is returned unchanged so the current model call
 * still receives the exact SDK-native image representation.
 */
export function withRetainableSessionImageOutputHook(
  tools: Tool<unknown>[],
  hook?: RetainableSessionImageOutputHook,
): Tool<unknown>[] {
  if (!hook) return tools;
  return tools.map((capabilityTool) => {
    if (capabilityTool.type !== "function" || capabilityTool.name !== "view_image") {
      return capabilityTool;
    }
    const invoke = capabilityTool.invoke;
    const toolName = capabilityTool.name;
    return {
      ...capabilityTool,
      invoke: async (runContext, input, details) => {
        const output = await invoke(runContext, input, details);
        const toolCallId = details?.toolCall?.callId;
        if (!toolCallId) {
          throw new Error(`${toolName} completed without a tool-call identity`);
        }
        await hook({ toolName, toolCallId, output });
        return output;
      },
    };
  });
}
