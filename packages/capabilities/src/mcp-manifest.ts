import { stableToolId } from "./revision";

export interface McpToolManifestEntry {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string | null;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface McpToolManifest {
  readonly server: {
    readonly name: string | null;
    readonly version: string | null;
    readonly instructions: string | null;
  } | null;
  readonly tools: readonly McpToolManifestEntry[];
}

export function extractMcpToolManifest(
  listToolsResult: unknown,
  metadata: {
    readonly serverInfo?: unknown;
    readonly instructions?: string;
  } = {},
): McpToolManifest {
  const listed =
    listToolsResult &&
    typeof listToolsResult === "object" &&
    Array.isArray((listToolsResult as { tools?: unknown }).tools)
      ? (listToolsResult as { tools: unknown[] }).tools
      : [];
  const seen = new Map<string, number>();
  const tools = listed.flatMap((value): McpToolManifestEntry[] => {
    if (!value || typeof value !== "object") return [];
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name.trim()) return [];
    const toolName = tool.name.trim();
    return [
      {
        toolId: stableToolId(toolName, seen),
        toolName,
        description: typeof tool.description === "string" ? tool.description : null,
        ...(tool.inputSchema !== undefined
          ? { inputSchema: tool.inputSchema }
          : tool.parameters !== undefined
            ? { inputSchema: tool.parameters }
            : {}),
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations && typeof tool.annotations === "object"
          ? { annotations: tool.annotations as Readonly<Record<string, unknown>> }
          : {}),
      },
    ];
  });
  const info =
    metadata.serverInfo && typeof metadata.serverInfo === "object"
      ? (metadata.serverInfo as Record<string, unknown>)
      : null;
  return {
    server: info
      ? {
          name: typeof info.name === "string" ? info.name : null,
          version: typeof info.version === "string" ? info.version : null,
          instructions: metadata.instructions ?? null,
        }
      : null,
    tools,
  };
}

export function deriveMcpNamespace(input: {
  readonly name?: string | null;
  readonly endpoint?: string | null;
  readonly command?: string | null;
}): string {
  const candidate =
    input.name?.trim() || hostname(input.endpoint) || basename(input.command) || "mcp";
  return stableToolId(candidate);
}

function hostname(value: string | null | undefined): string {
  if (!value || !URL.canParse(value)) return "";
  return new URL(value).hostname;
}

function basename(value: string | null | undefined): string {
  return value?.trim().split(/[\\/]/).pop() ?? "";
}
