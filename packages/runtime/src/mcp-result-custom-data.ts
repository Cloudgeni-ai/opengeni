import {
  AttemptToolResult,
  type AttemptToolResult as AttemptToolResultValue,
} from "@opengeni/contracts";
import type { MCPServer } from "@openai/agents";

export const OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY = "__opengeniMcpResultV1" as const;
export const OPENGENI_INNER_MCP_CUSTOM_DATA_KEY = "__opengeniInnerMcpCustomData" as const;

type McpCustomDataExtractor = NonNullable<MCPServer["customDataExtractor"]>;
type McpCustomDataContext = Parameters<McpCustomDataExtractor>[0];

function contentFromModelOutput(output: unknown): unknown[] {
  return Array.isArray(output) ? output : [output];
}

/**
 * Build the SDK-only bridge that retains the complete MCP result while leaving
 * the model-visible output on the SDK's existing content-based path.
 */
export function createMcpResultCustomDataExtractor(input?: {
  innerServer?: MCPServer;
  unprefixToolName?: (toolName: string) => string;
}): McpCustomDataExtractor {
  const innerExtractor = input?.innerServer?.customDataExtractor;
  return async (context) => {
    const result = AttemptToolResult.parse({
      content: contentFromModelOutput(context.toolOutput),
      ...(context.structuredContent === undefined
        ? {}
        : { structuredContent: context.structuredContent }),
      ...(typeof context.isError === "boolean" ? { isError: context.isError } : {}),
      ...(context.resultMeta === undefined ? {} : { _meta: context.resultMeta }),
    });

    let innerCustomData: Record<string, unknown> | null | undefined;
    if (innerExtractor && input?.innerServer) {
      const innerContext: McpCustomDataContext = {
        ...context,
        serverName: input.innerServer.name,
        toolName: input.unprefixToolName?.(context.toolName) ?? context.toolName,
      };
      innerCustomData = await innerExtractor(innerContext);
    }

    return {
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: result,
      ...(innerCustomData == null ? {} : { [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: innerCustomData }),
    };
  };
}

export function mcpResultFromCustomData(customData: unknown): AttemptToolResultValue | null {
  if (!customData || typeof customData !== "object" || Array.isArray(customData)) return null;
  const marker = (customData as Record<string, unknown>)[OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY];
  const parsed = AttemptToolResult.safeParse(marker);
  return parsed.success ? parsed.data : null;
}
