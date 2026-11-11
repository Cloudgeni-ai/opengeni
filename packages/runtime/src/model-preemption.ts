import { protocol, type ModelRequest, type StreamEvent } from "@openai/agents";
import { randomUUID } from "node:crypto";

/**
 * The abort reason of a model request that new user input (a Steer) cut short
 * while the model was still generating.
 *
 * A transport that sees this reason on `request.signal` ends its stream with
 * {@link preemptedResponseDone} instead of throwing, carrying only the output
 * items the provider already marked complete. A transport that throws instead
 * is still correct: the shared wrapper then ends the response with no output.
 */
export class ModelPreemption extends Error {
  constructor() {
    super("Model request preempted by new user input");
    this.name = "ModelPreemption";
  }
}

export function isModelPreempted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof ModelPreemption;
}

const PREEMPTED = "opengeniPreempted";
const CUT_OFF_TEXT = "opengeniCutOffText";
/** Bound on the cut-off text a preempted response reports for display. */
const CUT_OFF_TEXT_MAX_CHARS = 16_000;
/**
 * How long a preempted request may take to end on its own. A transport that
 * honours the abort ends at once with its completed messages; one that does
 * not (or is stalled between events) is cut when this runs out.
 */
export const PREEMPTION_GRACE_MS = 200;
const PREEMPTION_DEADLINE = Symbol("preemption deadline");

type ResponseDone = Extract<StreamEvent, { type: "response_done" }>;
type OutputItem = ResponseDone["response"]["output"][number];

/** Whether a model stream event is the terminal event of a preempted request. */
export function isPreemptedModelResponse(event: unknown): boolean {
  const data = event as { type?: unknown; response?: { providerData?: Record<string, unknown> } };
  return data?.type === "response_done" && data.response?.providerData?.[PREEMPTED] === true;
}

/** Streamed text of the preempted response that never completed. Display only. */
export function preemptedResponseCutOffText(event: unknown): string {
  if (!isPreemptedModelResponse(event)) return "";
  const text = (event as ResponseDone).response.providerData?.[CUT_OFF_TEXT];
  return typeof text === "string" ? text : "";
}

/**
 * Keep only what the person already saw finish: provider-completed assistant
 * messages, as plain text. Everything else from a cut-off request is dropped:
 * unfinished text, reasoning (its signature or encrypted state belongs to a
 * response that never ended), hosted tool items, and tool calls, which never
 * started executing because tools run only after a response completes. History
 * therefore never holds a call without its result.
 */
function keptPreemptedOutput(output: readonly unknown[]): OutputItem[] {
  const kept: OutputItem[] = [];
  for (const item of output) {
    const message = item as {
      type?: unknown;
      role?: unknown;
      status?: unknown;
      content?: unknown;
      id?: unknown;
      phase?: unknown;
    };
    if (message.type !== "message" || message.role !== "assistant") continue;
    if (message.status !== undefined && message.status !== "completed") continue;
    if (!Array.isArray(message.content)) continue;
    const content = message.content.flatMap((part: { type?: unknown; text?: unknown }) =>
      part?.type === "output_text" && typeof part.text === "string" && part.text.length > 0
        ? [{ type: "output_text" as const, text: part.text }]
        : [],
    );
    if (content.length === 0) continue;
    kept.push({
      type: "message",
      role: "assistant",
      status: "completed",
      ...(typeof message.id === "string" ? { id: message.id } : {}),
      ...(message.phase === "commentary" || message.phase === "final_answer"
        ? { phase: message.phase }
        : {}),
      content,
    } as OutputItem);
  }
  return kept;
}

/** Kept text per message id. */
function keptTexts(output: readonly OutputItem[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const item of output) {
    const message = item as { id?: unknown; content?: Array<{ text?: unknown }> };
    if (typeof message.id !== "string") continue;
    const text = (message.content ?? [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    texts.set(message.id, text);
  }
  return texts;
}

/**
 * The terminal event of a preempted request. `output` may hold anything the
 * transport saw completed; only completed assistant messages are kept. Usage is
 * what the provider reported before the cut (often only input, or nothing).
 */
export function preemptedResponseDone(input: {
  id?: string | undefined;
  requestId?: string | undefined;
  /** Anything the transport saw completed, in SDK or provider wire shape. */
  output?: readonly unknown[];
  usage?: ResponseDone["response"]["usage"] | undefined;
}): ResponseDone {
  return protocol.StreamEventResponseCompleted.parse({
    type: "response_done",
    response: {
      id: input.id ?? `preempted_${randomUUID()}`,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      output: keptPreemptedOutput(input.output ?? []),
      usage: input.usage ?? { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      providerData: { [PREEMPTED]: true },
    },
  }) as ResponseDone;
}

/**
 * Run one streamed model request that a Steer may cut short.
 *
 * Without a preemption signal this is a plain pass-through. With one, the
 * request receives an abort signal that fires on preemption as well as on the
 * caller's own cancellation. A preempted request ends with a `response_done`
 * that holds only provider-completed assistant messages and reports the
 * streamed text that never completed (for display only). Earlier history is
 * untouched, so the next request reuses the cached prefix; the only waste is
 * the cut-off output.
 */
export async function* streamWithPreemption(
  request: ModelRequest,
  preemption: AbortSignal | undefined,
  open: (request: ModelRequest) => AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  if (!preemption) {
    yield* open(request);
    return;
  }
  if (preemption.aborted) {
    // The Steer landed between admission and dispatch: nothing was sent.
    yield preemptedResponseDone({});
    return;
  }
  const controller = new AbortController();
  const cut = () => controller.abort(new ModelPreemption());
  preemption.addEventListener("abort", cut, { once: true });
  const signal = request.signal
    ? AbortSignal.any([request.signal, controller.signal])
    : controller.signal;
  // Streamed text per output item, to report what never completed.
  const streamed = new Map<string, string>();
  let anonymousText = "";
  let terminal = false;
  const cutOffText = (kept: readonly OutputItem[]): string => {
    const keptText = keptTexts(kept);
    let text = anonymousText;
    for (const [itemId, itemText] of streamed) {
      const done = keptText.get(itemId);
      // A kept message's streamed text beyond what was kept never completed.
      if (done === undefined) text += itemText;
      else if (itemText.length > done.length && itemText.startsWith(done))
        text += itemText.slice(done.length);
    }
    return text.length > CUT_OFF_TEXT_MAX_CHARS ? text.slice(0, CUT_OFF_TEXT_MAX_CHARS) : text;
  };
  const finish = (event: ResponseDone): ResponseDone => {
    const done = preemptedResponseDone({
      id: event.response.id,
      requestId: event.response.requestId,
      output: event.response.output,
      usage: event.response.usage,
    });
    const text = cutOffText(done.response.output);
    if (text) done.response.providerData = { ...done.response.providerData, [CUT_OFF_TEXT]: text };
    return done;
  };
  // A preemption ends the request within the grace period even when the
  // transport ignores its abort signal: each read is raced against a deadline
  // that starts when the Steer arrives.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof PREEMPTION_DEADLINE>((resolve) => {
    const arm = () => {
      deadlineTimer = setTimeout(() => resolve(PREEMPTION_DEADLINE), PREEMPTION_GRACE_MS);
    };
    controller.signal.addEventListener("abort", arm, { once: true });
  });
  const iterator = open({ ...request, signal })[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      const pending = iterator.next();
      const next = terminal ? await pending : await Promise.race([pending, deadline]);
      if (next === PREEMPTION_DEADLINE) {
        // The abandoned read may still settle; it must not surface later.
        pending.catch(() => undefined);
        if (request.signal?.aborted) throw request.signal.reason;
        yield finish(preemptedResponseDone({}));
        return;
      }
      if (next.done) {
        exhausted = true;
        break;
      }
      const event = next.value;
      if (event.type === "output_text_delta") {
        if (event.itemId)
          streamed.set(event.itemId, (streamed.get(event.itemId) ?? "") + event.delta);
        else anonymousText += event.delta;
      }
      if (event.type === "response_done") {
        terminal = true;
        // A transport that honours preemption marks its own partial response.
        yield isPreemptedModelResponse(event) ? finish(event) : event;
        continue;
      }
      yield event;
    }
  } catch (error) {
    // Only a preemption of a request that has not finished becomes a clean
    // end; the caller's own cancellation and every other failure propagate.
    if (terminal || !controller.signal.aborted || request.signal?.aborted) throw error;
    yield finish(preemptedResponseDone({}));
  } finally {
    clearTimeout(deadlineTimer);
    preemption.removeEventListener("abort", cut);
    // Close the transport stream when this ends early (a cut, a failure, or a
    // consumer that stops reading); never wait on a transport that hangs.
    if (!exhausted) void iterator.return?.()?.catch(() => undefined);
  }
}
