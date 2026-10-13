import {
  AttemptToolResult,
  omitStructuredContentTextDuplicates,
  type AttemptToolResult as AttemptToolResultValue,
} from "@opengeni/contracts";
import { UserError, type MCPServer } from "@openai/agents";
import { randomUUID } from "node:crypto";
import { normalizeProtocolJsonValue } from "./protocol-json";
import { EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY } from "./sandbox/exec-output-spill";

export const OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY = "__opengeniMcpResultV1" as const;
export const OPENGENI_INNER_MCP_CUSTOM_DATA_KEY = "__opengeniInnerMcpCustomData" as const;

const SDK_RESULT_PROJECTION = Symbol("opengeni.sdkMcpResultProjection");
const MCP_RESULT_BRIDGE_EXTRACTORS = new WeakSet<McpCustomDataExtractor>();

type McpCustomDataExtractor = NonNullable<MCPServer["customDataExtractor"]>;
type McpCustomDataContext = Parameters<McpCustomDataExtractor>[0];
type McpToolMetaResolver = NonNullable<MCPServer["toolMetaResolver"]>;
type McpToolMetaContext = Parameters<McpToolMetaResolver>[0];

function contentFromModelOutput(output: unknown): unknown[] {
  return Array.isArray(output) ? output : [output];
}

export function sdkModelOutputForServer(
  server: MCPServer,
  result: AttemptToolResultValue,
): unknown {
  if (result.content.some((entry) => entry.type !== "text")) {
    return result.content.length === 1 ? result.content[0] : result.content;
  }
  if (
    server.useStructuredContent === true &&
    result.isError !== true &&
    result.structuredContent !== undefined
  ) {
    return JSON.stringify(result.structuredContent);
  }
  return result.content.length === 1 ? result.content[0] : result.content;
}

/** Image types every supported model provider accepts as inline input. */
const MODEL_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type McpModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function withheldBlockText(kind: string, mimeType: unknown, data: unknown, uri?: unknown): string {
  const facts = [
    typeof mimeType === "string" && mimeType ? mimeType : null,
    typeof data === "string" ? `${base64ByteLength(data)} bytes` : null,
  ].filter((fact): fact is string => fact !== null);
  const source = typeof uri === "string" && uri ? ` ${uri}` : "";
  const detail = facts.length ? ` (${facts.join(", ")})` : "";
  return `[The tool returned ${kind}${source}${detail}. It cannot be shown to the model.]`;
}

function modelBlockFromMcpContent(entry: unknown): McpModelContentBlock {
  if (!isPlainRecord(entry)) return { type: "text", text: JSON.stringify(entry) };
  if (entry.type === "text" && typeof entry.text === "string") {
    return { type: "text", text: entry.text };
  }
  if (entry.type === "image" && typeof entry.data === "string") {
    const mimeType = typeof entry.mimeType === "string" ? entry.mimeType.toLowerCase() : "";
    return MODEL_IMAGE_MEDIA_TYPES.has(mimeType) && entry.data.length > 0
      ? { type: "image", data: entry.data, mimeType }
      : { type: "text", text: withheldBlockText("an image", entry.mimeType, entry.data) };
  }
  if (entry.type === "audio") {
    return { type: "text", text: withheldBlockText("audio", entry.mimeType, entry.data) };
  }
  if (entry.type === "resource" && isPlainRecord(entry.resource)) {
    const resource = entry.resource;
    if (typeof resource.text === "string") {
      const kind = typeof resource.mimeType === "string" ? ` (${resource.mimeType})` : "";
      return { type: "text", text: `Resource ${String(resource.uri)}${kind}:\n${resource.text}` };
    }
    const mimeType = typeof resource.mimeType === "string" ? resource.mimeType.toLowerCase() : "";
    if (typeof resource.blob === "string" && MODEL_IMAGE_MEDIA_TYPES.has(mimeType)) {
      return { type: "image", data: resource.blob, mimeType };
    }
    return {
      type: "text",
      text: withheldBlockText("a resource", resource.mimeType, resource.blob, resource.uri),
    };
  }
  // resource_link and future block types carry no raw bytes: show their
  // protocol fields, minus block-level metadata meant for clients.
  const { _meta: _blockMeta, ...visible } = entry;
  return { type: "text", text: JSON.stringify(visible) };
}

/**
 * What the model sees of one MCP tool result. MCP separates content for the
 * model from protocol data for clients: text and images go to the model as
 * native blocks (so pixels reach it as image input, not base64 text);
 * structuredContent is added once as compact JSON, and a text block that only
 * repeats it is dropped; an error result is marked as one. `_meta` and non-standard
 * envelope fields stay in the retained audit result only.
 */
export function mcpResultModelContent(result: AttemptToolResultValue): McpModelContentBlock[] {
  const deduplicated = omitStructuredContentTextDuplicates(result);
  const blocks: McpModelContentBlock[] = [];
  if (result.isError === true) blocks.push({ type: "text", text: "The tool reported an error." });
  for (const entry of deduplicated.content) blocks.push(modelBlockFromMcpContent(entry));
  if (result.structuredContent !== undefined) {
    blocks.push({
      type: "text",
      text: `Structured result: ${JSON.stringify(result.structuredContent)}`,
    });
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "The tool returned no content." });
  return blocks;
}

function cloneSdkMcpCustomDataContextValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSdkJsonCompatible(value: unknown): void {
  if (value == null) return;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return;
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new UserError("customDataExtractor must return JSON-compatible data.");
    }
    return;
  }
  if (
    valueType === "undefined" ||
    valueType === "function" ||
    valueType === "symbol" ||
    valueType === "bigint"
  ) {
    throw new UserError("customDataExtractor must return JSON-compatible data.");
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertSdkJsonCompatible(entry));
    return;
  }
  if (!isPlainRecord(value)) {
    throw new UserError("customDataExtractor must return JSON-compatible data.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new UserError("customDataExtractor must return JSON-compatible data.");
    }
    assertSdkJsonCompatible(value[key]);
  }
}

function normalizeSdkToolOutputCustomData(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (!isPlainRecord(value)) {
    throw new UserError("customDataExtractor must return an object or null.");
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new UserError("customDataExtractor must return an object with string keys.");
  }
  if (Object.keys(value).length === 0) return undefined;
  assertSdkJsonCompatible(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeMcpResult(value: unknown): AttemptToolResultValue {
  return normalizeProtocolJsonValue(AttemptToolResult.parse(value), "$.mcpResult");
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
        normalizeMcpResult({
          content: contentFromModelOutput(context.toolOutput),
          ...(context.structuredContent === undefined
            ? {}
            : { structuredContent: context.structuredContent }),
          ...(typeof context.isError === "boolean" ? { isError: context.isError } : {}),
          ...(context.resultMeta === undefined ? {} : { _meta: context.resultMeta }),
        });

      let innerCustomData: Record<string, unknown> | undefined;
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
          toolOutput: cloneSdkMcpCustomDataContextValue(
            sdkModelOutputForServer(this.input.innerServer, result),
          ),
          ...(result.structuredContent === undefined
            ? {}
            : {
                structuredContent: cloneSdkMcpCustomDataContextValue(result.structuredContent),
              }),
          ...(result.isError === undefined ? {} : { isError: result.isError }),
          ...(result._meta === undefined
            ? {}
            : { resultMeta: cloneSdkMcpCustomDataContextValue(result._meta) }),
        };
        const normalizedInnerCustomData = normalizeSdkToolOutputCustomData(
          await innerExtractor(innerContext),
        );
        if (
          normalizedInnerCustomData &&
          MCP_RESULT_BRIDGE_EXTRACTORS.has(innerExtractor) &&
          Object.hasOwn(normalizedInnerCustomData, OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY)
        ) {
          // A PrefixedMcpServer may itself be wrapped by another prefixed
          // server. The outer bridge already retains the exact result, so do
          // not nest another copy of Opengeni's private marker. Preserve only
          // the actual extractor payload carried through the inner bridge.
          const nestedInnerCustomData =
            normalizedInnerCustomData[OPENGENI_INNER_MCP_CUSTOM_DATA_KEY];
          innerCustomData = isPlainRecord(nestedInnerCustomData)
            ? nestedInnerCustomData
            : undefined;
        } else {
          innerCustomData = normalizedInnerCustomData;
        }
      }

      return {
        [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: result,
        ...(innerCustomData === undefined
          ? {}
          : { [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: innerCustomData }),
      };
    };
    MCP_RESULT_BRIDGE_EXTRACTORS.add(this.customDataExtractor);
  }

  async captureResult(
    args: Record<string, unknown> | null,
    invoke: (cleanArgs: Record<string, unknown> | null) => Promise<unknown>,
  ): Promise<unknown> {
    const { arguments: cleanArguments, token } = this.copyArgumentsWithoutToken(args);
    const invoked = await invoke(cleanArguments);
    const result = normalizeMcpResult(unwrapSdkMcpResultProjection(invoked));
    if (token) this.resultsByToken.set(token, result);
    if (token && this.input?.sdkModelOutput === "result") {
      // The SDK hands `content` to the model. Give it the model view of the
      // result (native text and image blocks, see mcpResultModelContent) and
      // nothing else, so it never falls back to serializing the envelope as
      // text. The bridge retains the exact audit copy out of band. The exact
      // result is also attached privately so another prefixed wrapper can
      // recover it before parsing it at its own boundary.
      const projected = { content: mcpResultModelContent(result) } as Record<PropertyKey, unknown>;
      Object.defineProperty(projected, SDK_RESULT_PROJECTION, {
        value: result,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return projected;
    }
    return result;
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

  private copyArgumentsWithoutToken(args: Record<string, unknown> | null): {
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

/** Recover the exact result from a prefixed server's SDK model projection. */
export function unwrapSdkMcpResultProjection(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const exact = (value as Record<PropertyKey, unknown>)[SDK_RESULT_PROJECTION];
  return exact === undefined ? value : exact;
}

// Opengeni's duplicate full-result markers: the exact MCP result and the full
// text of a spilled exec response. Both exist only for the durable event.
const DURABLE_EVENT_ONLY_CUSTOM_DATA_KEYS = [
  OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY,
  EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY,
] as const;

function stripMcpResultMarkerFromCustomData(customData: unknown): boolean {
  if (!isPlainRecord(customData)) return false;
  let stripped = false;
  for (const key of DURABLE_EVENT_ONLY_CUSTOM_DATA_KEYS) {
    if (!Object.hasOwn(customData, key)) continue;
    delete customData[key];
    stripped = true;
  }
  return stripped;
}

function compactSerializedRunItem(item: unknown): boolean {
  if (!isPlainRecord(item) || item.type !== "tool_call_output_item") return false;
  const customData = item.customData;
  if (!stripMcpResultMarkerFromCustomData(customData)) return false;
  if (isPlainRecord(customData) && Object.keys(customData).length === 0) {
    delete item.customData;
  }
  return true;
}

/**
 * Release Opengeni's duplicate full-result marker from the live SDK run item
 * after its normalized event has crossed the durable append boundary. The SDK
 * output and any inner extractor custom data remain available for subsequent
 * model calls and approval resume.
 */
export function releaseMcpResultCustomDataFromSdkEvent(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if ((event as { type?: unknown }).type !== "run_item_stream_event") return false;
  const item = (event as { item?: unknown }).item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const runItem = item as { type?: unknown; customData?: unknown };
  if (runItem.type !== "tool_call_output_item") return false;
  if (!stripMcpResultMarkerFromCustomData(runItem.customData)) return false;
  if (isPlainRecord(runItem.customData) && Object.keys(runItem.customData).length === 0) {
    delete runItem.customData;
  }
  return true;
}

/**
 * Remove only Opengeni's redundant full-result marker from an approval
 * RunState after the worker has durably recorded the exact event output. The
 * SDK's model-visible output, protocol raw item, and any inner custom data stay
 * intact, so approval resume behavior is unchanged without triplicating a
 * near-limit MCP result inside the 3 MiB approval-state envelope.
 */
export function compactMcpResultCustomDataRunState(serialized: string): string {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isPlainRecord(value)) return serialized;
    parsed = value;
  } catch {
    return serialized;
  }

  let changed = false;
  const compactItems = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (compactSerializedRunItem(item)) changed = true;
    }
  };
  compactItems(parsed.generatedItems);
  if (isPlainRecord(parsed.lastProcessedResponse)) {
    compactItems(parsed.lastProcessedResponse.newItems);
  }

  if (isPlainRecord(parsed.pendingAgentToolRuns)) {
    for (const [key, nested] of Object.entries(parsed.pendingAgentToolRuns)) {
      if (typeof nested !== "string") continue;
      const compacted = compactMcpResultCustomDataRunState(nested);
      if (compacted !== nested) {
        parsed.pendingAgentToolRuns[key] = compacted;
        changed = true;
      }
    }
  }

  return changed ? JSON.stringify(parsed) : serialized;
}

export function mcpResultFromCustomData(customData: unknown): AttemptToolResultValue | null {
  if (!customData || typeof customData !== "object" || Array.isArray(customData)) return null;
  const marker = (customData as Record<string, unknown>)[OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY];
  const parsed = AttemptToolResult.safeParse(marker);
  return parsed.success ? parsed.data : null;
}
