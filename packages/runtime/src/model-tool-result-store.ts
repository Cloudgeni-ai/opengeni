import type { AttemptToolDefinition, AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
  modelToolOutputInlineMaxBytes,
} from "@opengeni/codex";
import {
  TOOL_RESULT_READ_TOOL_NAME,
  TOOL_RESULT_STORED_META_KEY,
  TOOL_RESULT_STORED_TYPE,
  ToolResultStoredReceipt,
  type AttemptToolIdentity,
  type AttemptToolResult as AttemptToolResultValue,
  type ToolResultStoredReceipt as ToolResultStoredReceiptValue,
} from "@opengeni/contracts";
import type { Tool } from "@openai/agents";
import { projectCommandReadToolResultForModel } from "./command-read-model-projection";
import { projectKnowledgeToolResultForModel } from "./knowledge-model-projection";
import { mcpResultModelContent } from "./mcp-result-custom-data";
import { MCP_MAX_TOOL_RESULT_BYTES, mcpSerializedSizeBytes } from "./mcp-network";

/**
 * Lossless model-visible tool results.
 *
 * One tool result shows at most the model's inline tool-output policy as text
 * (100,000 UTF-8 bytes, about 25,000 tokens, by default). A result over that is
 * never cut: its full model-visible text is stored whole as a workspace File
 * and the model receives a view that fits. The view opens with a line saying
 * the result is partial (its size, the part shown and the exact call that
 * reads the rest by byte offset, `tool_result_read`), so a model never takes
 * the part for the whole, and the same call follows the part shown. Shell
 * output (`exec_command`, `write_stdin`) keeps its head and tail in that
 * view, since the end of a command's output is usually what matters; other
 * results show their start. Only results produced from now on pass through
 * here, so history that a provider already received is never rewritten: a
 * view is rendered once, when its result arrives, and stored as it was sent.
 *
 * Images are not text: they count only toward the 1 MiB transport bound on a
 * whole result, and an image past that bound is withheld with a note naming
 * its type and size.
 */

/** Name of the reader the views point at. */
export const STORED_TOOL_RESULT_READER_NAME = TOOL_RESULT_READ_TOOL_NAME;

export { TOOL_RESULT_STORED_META_KEY };

/** Function tools whose results are command output, shown as head and tail. */
const SHELL_OUTPUT_TOOL_NAMES: ReadonlySet<string> = new Set(["exec_command", "write_stdin"]);

/** Room kept for the framing the provider adds around one result. */
const VIEW_FRAMING_RESERVE_BYTES = 512;
/** A cut moves back to the end of a line when one is this close. */
const LINE_SNAP_WINDOW_BYTES = 4_096;

/**
 * How the model of this session can read a stored result:
 * - `reader`: `listed` when `tool_result_read` is in every request of the
 *   session (first-request tools revision 2 and later, frozen per session, so
 *   the tool list never changes within a chat); `searchable` when the turn's
 *   tool search router can load it by exact name (earlier sessions, whose
 *   tool list never carried it); `none` when it has no reader;
 * - `shell`: whether a shell can open a copy saved in the sandbox.
 */
export type StoredToolResultReaders = {
  reader: "listed" | "searchable" | "none";
  shell: boolean;
};

/** Identity of one result: an attempt-tool operation or a function-tool call. */
export type StoredToolResultKey =
  | { kind: "operation"; operationId: string }
  | { kind: "call"; callId: string };

export type StoredToolResult = {
  /** Workspace File id of the stored text; `tool_result_read` takes it. */
  resultId: string;
  /** UTF-8 bytes of the stored text. */
  byteSize: number;
  /** Where the shell can open a copy, or null when no copy is in the sandbox. */
  sandboxPath: string | null;
};

/** The attempt's store for results larger than the model may see inline. */
export type ModelToolResultStore = {
  store(input: { key: StoredToolResultKey; text: string }): Promise<StoredToolResult>;
  /** Inline text budget of the model making the current call, in UTF-8 bytes. */
  inlineMaxBytes(): number;
  readers(): StoredToolResultReaders;
};

/**
 * A tool's own model-visible copy of one exact result (for example a local MCP
 * bridge's compact mail cards). Only the model caller receives it.
 */
export type ProjectModelToolResult = (result: AttemptToolResultValue) => AttemptToolResultValue;

/**
 * UTF-8 text bytes a tool may use for its own model-visible copy (Gmail mail
 * cards, finished-command notices) so the result shows whole under the
 * policy, less a small allowance for framing such as `Structured result: `.
 */
export function modelToolTextBudgetBytes(
  policyTokens: number = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
): number {
  return Math.max(4_096, modelToolOutputInlineMaxBytes(policyTokens) - 512);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

type ModelContentBlock = ReturnType<typeof mcpResultModelContent>[number];

function modelTextOf(blocks: readonly ModelContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ModelContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * True when the model receives this result whole: its model-visible text is
 * within the inline budget and the whole result within the 1 MiB transport
 * bound that keeps large images out of history.
 */
export function modelToolResultFits(
  result: AttemptToolResultValue,
  inlineMaxBytes: number = modelToolOutputInlineMaxBytes(),
): boolean {
  if (mcpSerializedSizeBytes(result) > MCP_MAX_TOOL_RESULT_BYTES) return false;
  return utf8Bytes(modelTextOf(mcpResultModelContent(result))) <= inlineMaxBytes;
}

/** Snap a cut back to a UTF-8 character start, and to a line end when one is near. */
function headCut(bytes: Buffer, limit: number): number {
  let end = Math.max(0, Math.min(limit, bytes.length));
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end === 0 || end === bytes.length) return end;
  const newline = bytes.lastIndexOf(0x0a, end - 1);
  if (newline >= 0 && end - (newline + 1) <= LINE_SNAP_WINDOW_BYTES) {
    return newline + 1;
  }
  return end;
}

/** Snap a tail start forward to a UTF-8 character start, and to a line start when one is near. */
function tailCut(bytes: Buffer, start: number): number {
  let begin = Math.max(0, Math.min(start, bytes.length));
  while (begin < bytes.length && (bytes[begin]! & 0xc0) === 0x80) begin += 1;
  const newline = bytes.indexOf(0x0a, begin);
  if (newline >= 0 && newline + 1 - begin <= LINE_SNAP_WINDOW_BYTES && newline + 1 < bytes.length) {
    return newline + 1;
  }
  return begin;
}

function readCall(resultId: string, offset: number): string {
  return `${STORED_TOOL_RESULT_READER_NAME} ${JSON.stringify({ resultId, offset })}`;
}

/** The sentence that tells the model how to read bytes from `offset` on. */
function readInstruction(
  stored: StoredToolResult,
  offset: number,
  readers: StoredToolResultReaders,
): string {
  const copy =
    stored.sandboxPath !== null && readers.shell
      ? ` A copy is at ${stored.sandboxPath} where your shell runs.`
      : "";
  switch (readers.reader) {
    case "listed":
      return `Read on with ${readCall(stored.resultId, offset)}.${copy}`;
    case "searchable":
      return `Read on with ${readCall(stored.resultId, offset)}; load ${STORED_TOOL_RESULT_READER_NAME} by that exact name with tool search first.${copy}`;
    case "none":
      return copy
        ? `Read on from byte ${offset} of the copy at ${stored.sandboxPath} with the shell (for example with tail -c +${offset + 1}, grep or jq).`
        : "This session has no tool that reads it. If the tool can narrow its result (a filter, a smaller page or fewer fields), call it again so the result fits.";
  }
}

/**
 * The model's view of a stored result and its receipt. The view is at most
 * `inlineMaxBytes`: a first line saying the result is partial, with the total
 * size, the range left out and the call that reads it; then the start of the
 * text (or its head and tail for shell output) and a bracketed Opengeni note
 * after the part shown (between head and tail for shell output) with the same
 * call.
 */
export function storedToolResultView(input: {
  text: string;
  stored: StoredToolResult;
  inlineMaxBytes: number;
  readers: StoredToolResultReaders;
  shape: "head" | "head_and_tail";
}): { text: string; receipt: ToolResultStoredReceiptValue } {
  const bytes = Buffer.from(input.text, "utf8");
  const total = bytes.length;
  // Size the notes with the largest numbers they can hold, so the cut below
  // always leaves room for them.
  const headerFor = (from: number, to: number): string =>
    input.shape === "head"
      ? `[Opengeni: partial result. This tool result is ${total} bytes, more than the ${input.inlineMaxBytes} bytes one result may show, so only bytes 0 to ${from} are shown below; the whole result is stored. Treat what follows as incomplete until you read the rest. ${readInstruction(input.stored, from, input.readers)}]\n`
      : `[Opengeni: partial output. This output is ${total} bytes, more than the ${input.inlineMaxBytes} bytes one result may show, so bytes ${from} to ${to} are left out where marked below; the whole output is stored. ${readInstruction(input.stored, from, input.readers)}]\n`;
  const noteFor = (from: number, to: number): string =>
    input.shape === "head"
      ? `\n[Opengeni: end of the part shown, bytes 0 to ${from} of this ${total}-byte result. ${readInstruction(input.stored, from, input.readers)}]`
      : `\n[Opengeni: bytes ${from} to ${to} of this ${total}-byte output are not shown; the whole output is stored. ${readInstruction(input.stored, from, input.readers)}]\n`;
  const room = Math.max(
    1_024,
    input.inlineMaxBytes -
      utf8Bytes(headerFor(total, total)) -
      utf8Bytes(noteFor(total, total)) -
      VIEW_FRAMING_RESERVE_BYTES,
  );
  let from: number;
  let to: number;
  let text: string;
  if (input.shape === "head") {
    from = Math.max(1, headCut(bytes, room));
    to = total;
    text = `${headerFor(from, to)}${bytes.subarray(0, from).toString("utf8")}${noteFor(from, to)}`;
  } else {
    const headRoom = Math.floor(room / 2);
    from = Math.max(1, headCut(bytes, headRoom));
    to = Math.max(from + 1, tailCut(bytes, total - (room - from)));
    text = `${headerFor(from, to)}${bytes.subarray(0, from).toString("utf8")}${noteFor(from, to)}${bytes.subarray(to).toString("utf8")}`;
  }
  const receipt = ToolResultStoredReceipt.parse({
    type: TOOL_RESULT_STORED_TYPE,
    resultId: input.stored.resultId,
    byteSize: total,
    notShownFrom: from,
    notShownTo: Math.min(to, total),
    sandboxPath: input.stored.sandboxPath,
  });
  return { text, receipt };
}

/**
 * A view for a result whose text could not be stored: a first line saying it
 * is partial, its start, and a plain note.
 */
function unstoredView(text: string, inlineMaxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  const header = (shown: number) =>
    `[Opengeni: partial result. This tool result is ${bytes.length} bytes, more than the ${inlineMaxBytes} bytes one result may show, and it could not be stored, so only bytes 0 to ${shown} are shown below. Treat what follows as incomplete.]\n`;
  const note = (shown: number) =>
    `\n[Opengeni: this tool result is ${bytes.length} bytes, more than the ${inlineMaxBytes} bytes one result may show, and it could not be stored, so only bytes 0 to ${shown} are shown. If the tool can narrow its result (a filter, a smaller page or fewer fields), call it again so the result fits.]`;
  const room = Math.max(
    1_024,
    inlineMaxBytes -
      utf8Bytes(header(bytes.length)) -
      utf8Bytes(note(bytes.length)) -
      VIEW_FRAMING_RESERVE_BYTES,
  );
  const shown = Math.max(1, headCut(bytes, room));
  return `${header(shown)}${bytes.subarray(0, shown).toString("utf8")}${note(shown)}`;
}

/**
 * The image blocks of a result that fit the transport bound beside its text;
 * later ones become a short note naming their type and size.
 */
function boundedImageBlocks(
  blocks: readonly ModelContentBlock[],
  budgetBytes: number,
): AttemptToolResultValue["content"] {
  let remaining = budgetBytes;
  const out: AttemptToolResultValue["content"] = [];
  for (const block of blocks) {
    if (block.type !== "image") continue;
    const size = utf8Bytes(block.data);
    if (size <= remaining) {
      remaining -= size;
      out.push({ type: "image", data: block.data, mimeType: block.mimeType });
      continue;
    }
    out.push({
      type: "text",
      text: `[The tool returned an image (${block.mimeType}, ${Math.floor((size * 3) / 4)} bytes) too large to show.]`,
    });
  }
  return out;
}

/**
 * The model's view of one attempt-tool result that does not fit: its text
 * stored whole and shown from the start, its images kept within the
 * transport bound. Without a store the start is shown and the note says the
 * rest could not be kept.
 */
async function storedAttemptToolResult(
  visible: AttemptToolResultValue,
  operationId: string,
  store: ModelToolResultStore | undefined,
): Promise<AttemptToolResultValue> {
  const inlineMaxBytes = store?.inlineMaxBytes() ?? modelToolOutputInlineMaxBytes();
  // The error marker stays on the result itself; the stored text is the content.
  const blocks = mcpResultModelContent({ ...visible, isError: false });
  const text = modelTextOf(blocks);
  const images = boundedImageBlocks(
    blocks,
    Math.max(0, MCP_MAX_TOOL_RESULT_BYTES - inlineMaxBytes - 4_096),
  );
  const errorFlag = visible.isError === true ? { isError: true as const } : {};
  if (utf8Bytes(text) <= inlineMaxBytes) {
    // Only images were too large: the text is shown whole beside them.
    return {
      ...errorFlag,
      content: text.length > 0 ? [...images, { type: "text", text }] : images,
    };
  }
  if (!store) {
    return {
      ...errorFlag,
      content: [...images, { type: "text", text: unstoredView(text, inlineMaxBytes) }],
    };
  }
  let stored: StoredToolResult;
  try {
    stored = await store.store({ key: { kind: "operation", operationId }, text });
  } catch {
    return {
      ...errorFlag,
      content: [...images, { type: "text", text: unstoredView(text, inlineMaxBytes) }],
    };
  }
  const view = storedToolResultView({
    text,
    stored,
    inlineMaxBytes,
    readers: store.readers(),
    shape: "head",
  });
  return {
    ...errorFlag,
    content: [...images, { type: "text", text: view.text }],
    _meta: { ...visible._meta, [TOOL_RESULT_STORED_META_KEY]: view.receipt },
  };
}

/**
 * The single per-caller seam over one executor result. Codemode receives the
 * exact result. The model receives its model-visible projection (the tool's
 * own `projectForModel`, such as compact Gmail cards, or compact Knowledge
 * discovery output or plain-text command reads for the exact tool identity)
 * whole when it fits the inline budget; otherwise its text is stored whole
 * and the model receives a view with the call that reads the rest. A
 * projection that throws leaves the exact result in place. MCP-backed exact
 * results are bounded only by the 8 MiB MCP transport cap before this seam
 * runs, so a large MCP read is stored here like any other tool's.
 */
export async function projectAttemptToolResultForCaller(
  result: AttemptToolResultValue,
  context: AttemptToolExecutionContext,
  store?: ModelToolResultStore,
  identity?: AttemptToolIdentity,
  projectForModel?: ProjectModelToolResult,
): Promise<AttemptToolResultValue> {
  switch (context.caller.kind) {
    case "codemode":
      return result;
    case "model": {
      const own = projectForModel ? toolOwnModelProjection(projectForModel, result) : result;
      const visible = identity
        ? projectCommandReadToolResultForModel(
            identity,
            projectKnowledgeToolResultForModel(identity, own),
          )
        : own;
      const inlineMaxBytes = store?.inlineMaxBytes() ?? modelToolOutputInlineMaxBytes();
      if (modelToolResultFits(visible, inlineMaxBytes)) return visible;
      return await storedAttemptToolResult(visible, context.operationId, store);
    }
    default: {
      const unexpected: never = context.caller.kind;
      throw new Error(`unhandled tool caller ${unexpected}`);
    }
  }
}

function toolOwnModelProjection(
  projectForModel: ProjectModelToolResult,
  result: AttemptToolResultValue,
): AttemptToolResultValue {
  try {
    return projectForModel(result);
  } catch {
    return result;
  }
}

export function wrapAttemptToolExecute(
  execute: AttemptToolDefinition["execute"],
  store?: ModelToolResultStore,
  identity?: AttemptToolIdentity,
  projectForModel?: ProjectModelToolResult,
): AttemptToolDefinition["execute"] {
  return async (args, context) =>
    await projectAttemptToolResultForCaller(
      await execute(args, context),
      context,
      store,
      identity,
      projectForModel,
    );
}

export function wrapAttemptToolDefinitions(
  definitions: readonly AttemptToolDefinition[],
  store?: ModelToolResultStore,
): AttemptToolDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    execute: wrapAttemptToolExecute(definition.execute, store, definition.identity),
  }));
}

// ---------------------------------------------------------------------------
// Function tools (shell, web fetch, Skill reads and every other tool the
// Agents SDK invokes for the model): the same store over their output value.
// ---------------------------------------------------------------------------

type FunctionOutputParts = { text: string; nonText: unknown[] };

function isTextPart(value: unknown): value is { type: string; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.type === "text" || record.type === "input_text" || record.type === "output_text") &&
    typeof record.text === "string"
  );
}

function isNonTextPart(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  return (
    type === "image" ||
    type === "input_image" ||
    type === "file" ||
    type === "input_file" ||
    type === "computer_screenshot"
  );
}

/**
 * The text a function tool's output shows the model, and its non-text parts.
 * Null for an output that carries no text to measure.
 */
function functionOutputParts(output: unknown): FunctionOutputParts | null {
  if (typeof output === "string") return { text: output, nonText: [] };
  if (isTextPart(output)) return { text: output.text, nonText: [] };
  if (isNonTextPart(output)) return null;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    const nonText: unknown[] = [];
    for (const part of output) {
      if (typeof part === "string") texts.push(part);
      else if (isTextPart(part)) texts.push(part.text);
      else if (isNonTextPart(part)) nonText.push(part);
      else texts.push(JSON.stringify(part) ?? "");
    }
    return texts.length > 0 ? { text: texts.join("\n\n"), nonText } : null;
  }
  if (output && typeof output === "object") {
    try {
      const json = JSON.stringify(output);
      return json === undefined ? null : { text: json, nonText: [] };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The model's view of one function tool output, or the output itself when its
 * text fits. Shell output keeps its head and tail; other output its start.
 */
export async function storeOversizedFunctionToolOutput(input: {
  toolName: string;
  callId: string | undefined;
  output: unknown;
  store: ModelToolResultStore;
}): Promise<unknown> {
  const parts = functionOutputParts(input.output);
  if (!parts) return input.output;
  const inlineMaxBytes = input.store.inlineMaxBytes();
  if (utf8Bytes(parts.text) <= inlineMaxBytes) return input.output;
  if (!input.callId) {
    const view = unstoredView(parts.text, inlineMaxBytes);
    return parts.nonText.length > 0 ? [...parts.nonText, { type: "text", text: view }] : view;
  }
  let viewText: string;
  try {
    const stored = await input.store.store({
      key: { kind: "call", callId: input.callId },
      text: parts.text,
    });
    viewText = storedToolResultView({
      text: parts.text,
      stored,
      inlineMaxBytes,
      readers: input.store.readers(),
      shape: SHELL_OUTPUT_TOOL_NAMES.has(input.toolName) ? "head_and_tail" : "head",
    }).text;
  } catch {
    viewText = unstoredView(parts.text, inlineMaxBytes);
  }
  return parts.nonText.length > 0 ? [...parts.nonText, { type: "text", text: viewText }] : viewText;
}

const storingTools = new WeakMap<ModelToolResultStore, WeakMap<object, Tool<any>>>();

/** The same function tool, its oversized output stored and shown as a view. Stable per tool. */
export function modelToolResultStoringTool<T extends Tool<any>>(
  tool: T,
  store: ModelToolResultStore,
): T {
  if (tool.type !== "function") return tool;
  let cache = storingTools.get(store);
  if (!cache) {
    cache = new WeakMap();
    storingTools.set(store, cache);
  }
  const existing = cache.get(tool);
  if (existing) return existing as T;
  const invoke = tool.invoke.bind(tool);
  const next = {
    ...tool,
    invoke: async (...args: Parameters<typeof invoke>) => {
      const output = await invoke(...args);
      const details = args[2] as { toolCall?: { callId?: unknown } } | undefined;
      const callId = details?.toolCall?.callId;
      return (await storeOversizedFunctionToolOutput({
        toolName: tool.name,
        callId: typeof callId === "string" && callId.length > 0 ? callId : undefined,
        output,
        store,
      })) as Awaited<ReturnType<typeof invoke>>;
    },
  } as T;
  cache.set(tool, next);
  cache.set(next, next);
  return next;
}

type StoringAgent = {
  getAllTools: (runContext: any) => Promise<Tool<any>[]>;
  clone?: (config: any) => StoringAgent;
};

const agentStores = new WeakMap<object, ModelToolResultStore>();

/**
 * The tool as the agent's model receives its output: with the agent's store
 * installed, an oversized output is stored and shown as a view. For callers
 * that invoke a tool outside `getAllTools`, such as an approval resume.
 */
export function agentModelToolResultStoringTool<T extends Tool<any>>(agent: object, tool: T): T {
  const store = agentStores.get(agent);
  return store ? modelToolResultStoringTool(tool, store) : tool;
}

/**
 * Store every function tool's oversized output and show the model a view.
 * Install it inside the repeated-call guard's view of results (after it), so
 * the guard compares a tool's own output, and before finished-command
 * delivery, so notices are sized against the view. Clones get it too.
 */
export function installModelToolResultStore(
  agent: StoringAgent,
  store: ModelToolResultStore,
): void {
  if (agentStores.has(agent)) return;
  agentStores.set(agent, store);
  const getAllTools = agent.getAllTools.bind(agent);
  agent.getAllTools = async (runContext: unknown) =>
    (await getAllTools(runContext)).map((tool) => modelToolResultStoringTool(tool, store));
  const clone = agent.clone?.bind(agent);
  if (clone) {
    agent.clone = (config: unknown) => {
      const cloned = clone(config);
      installModelToolResultStore(cloned, store);
      return cloned;
    };
  }
}
