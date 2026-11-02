/**
 * Background command results delivered with the next tool result.
 *
 * A command the agent left running (a backgrounded `exec_command`) often
 * finishes while the model is busy with other tools. Its durable
 * `background_command_result` would otherwise reach the model only at the
 * next turn, so the model spends calls polling `command_read` to learn it.
 * Here every function tool's result is followed by the results of this
 * session's commands that finished since the model last heard about them:
 * command, exit status and the bounded start and end of the output.
 *
 * Taking a result observes the command and supersedes its pending inbox
 * input in one transaction (the same receipt a terminal `command_read`
 * records), so it is delivered once. The text is appended when the result is
 * produced and is stored with it, so earlier history and the prompt-cache
 * prefix never change. A result is attached only to plain-text tool results
 * (never to JSON, images or structured content, which code parses), and never
 * while the result could not reach the model in this turn (an input wait is
 * in flight or the turn is cancelled): those results stay pending and arrive
 * as ordinary input instead.
 */
import type { CallModelInputFilter, Tool } from "@openai/agents";
import { modelToolTextBudgetBytes } from "./tool-result-spill";

/** One finished command, as its durable result describes it. */
export type BackgroundCommandCompletion = {
  commandId: string;
  /** The result's one-line summary, naming the command and how it ended. */
  summary: string;
  /** Bounded output text; null when the result does not carry output. */
  output: string | null;
  notice: string | null;
};

/** Where finished commands come from: the worker's durable command results. */
export type CommandCompletionSource = {
  /**
   * Take the session's pending command results whose text fits `maxBytes`,
   * recording them as observed. Empty when none fit.
   */
  take(input: { maxBytes: number }): Promise<BackgroundCommandCompletion[]>;
  /**
   * UTF-8 bytes one model-visible tool result may use before its middle is
   * cut (see `modelToolTextBudgetBytes`). Results are attached only within
   * the room the tool's own output leaves, so they never push its end into
   * the cut. Omitted: the default budget.
   */
  maxTextBytes?: () => number;
  /**
   * Mask known secret values in the notice before it is appended (and stored),
   * for tools whose results the generic masking does not wrap.
   */
  mask?(text: string): Promise<string>;
  /** The turn's cancellation: nothing is taken once it is cancelled. */
  signal?: AbortSignal | undefined;
  /** The exact text appended to a tool result (unique: it names each command). */
  onDelivered?(appended: string): void;
  /** A failed take; the results stay pending for ordinary delivery. */
  onError?(error: unknown): void;
};

/** Model text for a wait refused because results it has not read arrived in this step. */
export const WAIT_AFTER_UNREAD_COMMAND_RESULTS =
  "Not waiting, and your reply was not shown: a background command finished during this step and its result is in another tool result of this step. Read it first, then wait again with your full reply if you still need to.";

/**
 * One attempt's delivery state. Results are attached only while the model
 * will read them in this turn: a result attached in a step that ends the turn
 * with an input wait would be stored but unread, and no longer pending to wake
 * that wait. So once a turn-ending call starts in a step, nothing more is
 * taken until the next model call, and that call is refused (the turn goes
 * on) when results were already attached in its step.
 */
export class CommandCompletionDelivery {
  private turnEndingCallStarted = false;
  private deliveredInStep = false;
  private readonly takes = new Set<Promise<unknown>>();

  constructor(private readonly source: CommandCompletionSource) {}

  /** The next model call receives every result attached so far. */
  modelCallStarting(): void {
    this.turnEndingCallStarted = false;
    this.deliveredInStep = false;
  }

  /** Before a turn-ending call runs: its refusal text, or null to run it. */
  async beforeTurnEndingCall(): Promise<string | null> {
    this.turnEndingCallStarted = true;
    while (this.takes.size > 0) await Promise.allSettled([...this.takes]);
    return this.deliveredInStep ? WAIT_AFTER_UNREAD_COMMAND_RESULTS : null;
  }

  /** The tool output followed by any finished commands, in its own shape. */
  async deliverWith(output: unknown): Promise<unknown> {
    const own = plainTextToolOutputText(output);
    if (this.turnEndingCallStarted || this.source.signal?.aborted || own === null) {
      return output;
    }
    const maxBytes = commandCompletionRoomBytes(
      Buffer.byteLength(own, "utf8"),
      this.source.maxTextBytes?.() ?? modelToolTextBudgetBytes(),
    );
    if (maxBytes < COMMAND_COMPLETION_NOTICE_MIN_ROOM_BYTES) return output;
    const take = (async () => {
      const completions = await this.source.take({ maxBytes });
      if (completions.length === 0) return null;
      const notice = renderCommandCompletionNotice(completions);
      return this.source.mask ? await this.source.mask(notice) : notice;
    })();
    this.takes.add(take);
    let notice: string | null;
    try {
      notice = await take;
    } catch (error) {
      this.source.onError?.(error);
      return output;
    } finally {
      this.takes.delete(take);
    }
    if (notice === null) return output;
    const next = appendToPlainTextToolOutput(output, notice);
    if (next === null) return output;
    this.deliveredInStep = true;
    this.source.onDelivered?.(notice);
    return next;
  }
}

/** Room for command results in one tool result, well inside the model's tool-output budget. */
export const COMMAND_COMPLETION_NOTICE_MAX_BYTES = 16_384;

/** Below this room nothing is taken: the results wait for a smaller tool result or arrive as input. */
export const COMMAND_COMPLETION_NOTICE_MIN_ROOM_BYTES = 1_024;

/** Headroom kept between the tool output plus notices and the cut. */
const COMMAND_COMPLETION_NOTICE_MARGIN_BYTES = 512;

/**
 * Bytes the notices may use after `ownBytes` of tool output within a model
 * text budget of `budgetBytes`: at most the notice cap, and never into the
 * part of the result the model's tool-output truncation would cut.
 */
export function commandCompletionRoomBytes(ownBytes: number, budgetBytes: number): number {
  return Math.max(
    0,
    Math.min(
      COMMAND_COMPLETION_NOTICE_MAX_BYTES,
      budgetBytes - ownBytes - COMMAND_COMPLETION_NOTICE_MARGIN_BYTES,
    ),
  );
}

/** Tools whose result ends the turn: results attached to them would wait for the next turn. */
const TURN_ENDING_TOOL_SUFFIXES = ["wait_for_input"] as const;

function endsTurn(name: string): boolean {
  return TURN_ENDING_TOOL_SUFFIXES.some(
    (suffix) => name === suffix || name.endsWith(`__${suffix}`),
  );
}

/** Model text for finished commands, appended after a tool's own result. */
export function renderCommandCompletionNotice(
  completions: readonly BackgroundCommandCompletion[],
): string {
  return completions
    .map((completion) => {
      const lines = [
        `[Background command finished] ${completion.summary}`,
        `Command ID: ${completion.commandId}`,
      ];
      if (completion.notice) lines.push(completion.notice);
      if (completion.output === null) {
        lines.push(`Output: read it with command_read.`);
      } else if (completion.output === "") {
        lines.push("Output: (none)");
      } else {
        lines.push("Output:", completion.output);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function parsesAsJson(text: string): boolean {
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[" && start !== '"') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The text of a plain-text tool output, or null when it is not plain text. */
function plainTextToolOutputText(output: unknown): string | null {
  if (appendToPlainTextToolOutput(output, "") === null) return null;
  return typeof output === "string" ? output : (output as { text: string }).text;
}

/**
 * The tool output with `text` appended, in the output's own shape, or null
 * when the output is not plain text: JSON, images and multi-part content are
 * parsed or rendered by code and are left exactly as the tool returned them.
 */
export function appendToPlainTextToolOutput(output: unknown, text: string): unknown {
  if (typeof output === "string") {
    return parsesAsJson(output) ? null : `${output}${output === "" ? "" : "\n\n"}${text}`;
  }
  if (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    (output as { type?: unknown }).type === "text" &&
    typeof (output as { text?: unknown }).text === "string" &&
    Object.keys(output).every((key) => key === "type" || key === "text")
  ) {
    const current = (output as { text: string }).text;
    return parsesAsJson(current)
      ? null
      : { type: "text", text: `${current}${current === "" ? "" : "\n\n"}${text}` };
  }
  return null;
}

/**
 * The tool's own output for audit views: without whichever of `appended` it
 * ends with (that text is then removed from the set), otherwise unchanged.
 */
export function withoutAppendedCommandCompletions(output: unknown, appended: Set<string>): unknown {
  for (const text of appended) {
    const own = withoutAppendedText(output, text);
    if (own !== output) {
      appended.delete(text);
      return own;
    }
  }
  return output;
}

/** The tool's own output without exactly `appended`, for audit views; otherwise unchanged. */
export function withoutAppendedText(output: unknown, appended: string): unknown {
  const strip = (text: string): string | null => {
    if (!text.endsWith(appended)) return null;
    const rest = text.slice(0, text.length - appended.length);
    return rest.endsWith("\n\n") ? rest.slice(0, -2) : rest;
  };
  if (typeof output === "string") return strip(output) ?? output;
  if (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    typeof (output as { text?: unknown }).text === "string"
  ) {
    const text = strip((output as { text: string }).text);
    return text === null ? output : { ...output, text };
  }
  return output;
}

const deliveringTools = new WeakMap<CommandCompletionDelivery, WeakMap<object, Tool<any>>>();

type ApplyPatchEditorResult = { status?: string; output?: string } | void | undefined;
type ApplyPatchEditor = Record<
  "createFile" | "updateFile" | "deleteFile",
  (operation: unknown, context?: unknown) => Promise<ApplyPatchEditorResult>
>;

/** A hosted `apply_patch` editor whose results are followed by any finished commands. */
function deliveringApplyPatchEditor(
  editor: ApplyPatchEditor,
  delivery: CommandCompletionDelivery,
): ApplyPatchEditor {
  const deliver =
    (method: keyof ApplyPatchEditor) =>
    async (operation: unknown, context?: unknown): Promise<ApplyPatchEditorResult> => {
      const result = await editor[method](operation, context);
      const output = result?.output ?? "";
      const next = await delivery.deliverWith(output);
      return next === output ? result : { ...result, output: next as string };
    };
  return {
    createFile: deliver("createFile"),
    updateFile: deliver("updateFile"),
    deleteFile: deliver("deleteFile"),
  };
}

/**
 * The same function tool (or hosted `apply_patch` tool), its result followed
 * by any finished commands. Stable per tool.
 */
export function commandCompletionDeliveringTool<T extends Tool<any>>(
  tool: T,
  delivery: CommandCompletionDelivery,
): T {
  if (tool.type !== "function" && tool.type !== "apply_patch") return tool;
  let cache = deliveringTools.get(delivery);
  if (!cache) {
    cache = new WeakMap();
    deliveringTools.set(delivery, cache);
  }
  const existing = cache.get(tool);
  if (existing) return existing as T;
  if (tool.type === "apply_patch") {
    const editor = (tool as unknown as { editor?: ApplyPatchEditor }).editor;
    if (!editor) return tool;
    const next = { ...tool, editor: deliveringApplyPatchEditor(editor, delivery) } as T;
    cache.set(tool, next);
    cache.set(next, next);
    return next;
  }
  const invoke = tool.invoke.bind(tool);
  const turnEnding = endsTurn(tool.name);
  const next = {
    ...tool,
    invoke: async (...args: Parameters<typeof invoke>) => {
      if (turnEnding) {
        const refusal = await delivery.beforeTurnEndingCall();
        return (refusal ?? (await invoke(...args))) as Awaited<ReturnType<typeof invoke>>;
      }
      const output = await invoke(...args);
      return (await delivery.deliverWith(output)) as Awaited<ReturnType<typeof invoke>>;
    },
  } as T;
  cache.set(tool, next);
  cache.set(next, next);
  return next;
}

type DeliveringAgent = {
  getAllTools: (runContext: any) => Promise<Tool<any>[]>;
  clone?: (config: any) => DeliveringAgent;
};

const agentDeliveries = new WeakMap<object, CommandCompletionDelivery>();

/**
 * Wrap the agent's function tools so finished commands follow their results.
 * Install it after the tool wrappers that shape results and before secret
 * masking, which must see the appended text too. Clones get it too.
 */
export function installCommandCompletionDelivery(
  agent: DeliveringAgent,
  delivery: CommandCompletionDelivery,
): void {
  if (agentDeliveries.has(agent)) return;
  agentDeliveries.set(agent, delivery);
  const getAllTools = agent.getAllTools.bind(agent);
  agent.getAllTools = async (runContext: unknown) =>
    (await getAllTools(runContext)).map((tool) => commandCompletionDeliveringTool(tool, delivery));
  const clone = agent.clone?.bind(agent);
  if (clone) {
    agent.clone = (config: unknown) => {
      const cloned = clone(config);
      installCommandCompletionDelivery(cloned, delivery);
      return cloned;
    };
  }
}

/** Tools the runner binds by name outside `getAllTools` deliver results too. */
export function commandCompletionToolResolver<
  R extends ((input: any) => Promise<Tool<any> | null | undefined>) | undefined,
>(agent: object, resolve: R): R {
  const delivery = agentDeliveries.get(agent);
  if (!delivery || !resolve) return resolve;
  const wrapped = async (input: unknown) => {
    const tool = await resolve(input);
    return tool ? commandCompletionDeliveringTool(tool, delivery) : tool;
  };
  return wrapped as R;
}

/**
 * A pass-through model-input filter marking each model call, after which the
 * model has every result attached so far. Undefined without delivery.
 */
export function commandCompletionModelCallFilter(agent: object): CallModelInputFilter | undefined {
  const delivery = agentDeliveries.get(agent);
  if (!delivery) return undefined;
  return ({ modelData }) => {
    delivery.modelCallStarting();
    return modelData;
  };
}
