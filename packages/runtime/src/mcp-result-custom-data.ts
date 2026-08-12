import {
  AttemptToolResult,
  type AttemptToolResult as AttemptToolResultValue,
} from "@opengeni/contracts";
import type { MCPServer } from "@openai/agents";
import { randomUUID } from "node:crypto";

export const OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY = "__opengeniMcpResultV1" as const;
export const OPENGENI_INNER_MCP_CUSTOM_DATA_KEY = "__opengeniInnerMcpCustomData" as const;

type McpCustomDataExtractor = NonNullable<MCPServer["customDataExtractor"]>;
type McpCustomDataContext = Parameters<McpCustomDataExtractor>[0];
type McpToolMetaResolver = NonNullable<MCPServer["toolMetaResolver"]>;
type McpToolMetaContext = Parameters<McpToolMetaResolver>[0];

function contentFromModelOutput(output: unknown): unknown[] {
  return Array.isArray(output) ? output : [output];
}

function sdkModelOutputForServer(server: MCPServer, result: AttemptToolResultValue): unknown {
  if (
    server.useStructuredContent === true &&
    result.isError !== true &&
    result.structuredContent !== undefined
  ) {
    return JSON.stringify(result.structuredContent);
  }
  return result.content.length === 1 ? result.content[0] : result.content;
}

/**
 * The Agents SDK custom-data callback receives only the standard MCP result
 * fields. This bridge binds the original full result to the SDK invocation by
 * temporarily adding one instance-private key to the parsed argument object.
 * The key is removed before the MCP server sees the arguments and is consumed
 * before an inner custom-data extractor runs, so neither boundary observes it.
 */
export class McpResultCustomDataBridge {
  private readonly argumentKey = `__opengeniMcpResultCall_${randomUUID()}`;
  private readonly resultsByToken = new Map<string, AttemptToolResultValue>();
  private nextToken = 0;

  readonly toolMetaResolver: McpToolMetaResolver;
  readonly customDataExtractor: McpCustomDataExtractor;

  constructor(
    private readonly input?: {
      innerServer?: MCPServer;
      unprefixToolName?: (toolName: string) => string;
      sdkModelOutput?: "content" | "result";
    },
  ) {
    this.toolMetaResolver = async (context) => {
      const innerMeta = await this.resolveInnerMeta(context);
      const args = context.arguments;
      if (!args || !Object.isExtensible(args)) return innerMeta;
      const token = `${++this.nextToken}`;
      Object.defineProperty(args, this.argumentKey, {
        value: token,
        enumerable: true,
        configurable: true,
        writable: false,
      });
      return innerMeta;
    };

    this.customDataExtractor = async (context) => {
      const { arguments: cleanArguments, token } = this.consumeArguments(context.arguments);
      const bridgedResult = token ? this.resultsByToken.get(token) : undefined;
      if (token) this.resultsByToken.delete(token);
      const result =
        bridgedResult ??
        AttemptToolResult.parse({
          content: contentFromModelOutput(context.toolOutput),
          ...(context.structuredContent === undefined
            ? {}
            : { structuredContent: context.structuredContent }),
          ...(typeof context.isError === "boolean" ? { isError: context.isError } : {}),
          ...(context.resultMeta === undefined ? {} : { _meta: context.resultMeta }),
        });

      let innerCustomData: Record<string, unknown> | null | undefined;
      const innerExtractor = this.input?.innerServer?.customDataExtractor;
      if (innerExtractor && this.input?.innerServer) {
        const {
          resultMeta: _resultMeta,
          structuredContent: _structuredContent,
          isError: _isError,
          toolOutput: _toolOutput,
          ...baseContext
        } = context;
        const innerContext: McpCustomDataContext = {
          ...baseContext,
          arguments: cleanArguments,
          serverName: this.input.innerServer.name,
          toolName: this.input.unprefixToolName?.(context.toolName) ?? context.toolName,
          toolOutput: sdkModelOutputForServer(this.input.innerServer, result),
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
          ...(result.isError === undefined ? {} : { isError: result.isError }),
          ...(result._meta === undefined ? {} : { resultMeta: result._meta }),
        };
        innerCustomData = await innerExtractor(innerContext);
      }

      return {
        [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: result,
        ...(innerCustomData == null
          ? {}
          : { [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: innerCustomData }),
      };
    };
  }

  async captureResult(
    args: Record<string, unknown> | null,
    invoke: (cleanArgs: Record<string, unknown> | null) => Promise<unknown>,
  ): Promise<unknown> {
    const token = this.takeToken(args);
    try {
      const result = AttemptToolResult.parse(await invoke(args));
      if (token) this.resultsByToken.set(token, result);
      if (token && this.input?.sdkModelOutput === "result") {
        // The prefixed server historically exposed the complete MCP result as
        // model output. Keep that shape while the SDK reads the standard result
        // fields and the bridge retains the exact audit copy out of band.
        return { ...result, content: result };
      }
      return result;
    } finally {
      if (args && token) {
        Object.defineProperty(args, this.argumentKey, {
          value: token,
          enumerable: true,
          configurable: true,
          writable: false,
        });
      }
    }
  }

  private async resolveInnerMeta(
    context: McpToolMetaContext,
  ): Promise<Record<string, unknown> | null | undefined> {
    const innerResolver = this.input?.innerServer?.toolMetaResolver;
    if (!innerResolver || !this.input?.innerServer) return undefined;
    return await innerResolver({
      ...context,
      serverName: this.input.innerServer.name,
      toolName: this.input.unprefixToolName?.(context.toolName) ?? context.toolName,
    });
  }

  private takeToken(args: Record<string, unknown> | null): string | null {
    if (!args) return null;
    const token = args[this.argumentKey];
    if (typeof token !== "string") return null;
    delete args[this.argumentKey];
    return token;
  }

  private consumeArguments(args: Record<string, unknown> | null): {
    arguments: Record<string, unknown> | null;
    token: string | null;
  } {
    if (!args || typeof args[this.argumentKey] !== "string") {
      return { arguments: args, token: null };
    }
    const token = args[this.argumentKey] as string;
    const cleanArguments = { ...args };
    delete cleanArguments[this.argumentKey];
    return { arguments: cleanArguments, token };
  }
}

export function mcpResultFromCustomData(customData: unknown): AttemptToolResultValue | null {
  if (!customData || typeof customData !== "object" || Array.isArray(customData)) return null;
  const marker = (customData as Record<string, unknown>)[OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY];
  const parsed = AttemptToolResult.safeParse(marker);
  return parsed.success ? parsed.data : null;
}
