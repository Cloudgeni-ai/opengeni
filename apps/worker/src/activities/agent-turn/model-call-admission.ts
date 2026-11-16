import type { StreamEvent } from "@openai/agents";

/**
 * The SDK's terminal model response. It settles while the consumer reads the
 * response's own items, which commit with its usage; the response normalizes
 * to no session event of its own.
 */
export function settlesAlongsideResponseItems(event: { type: string; data?: unknown }): boolean {
  return (
    event.type === "raw_model_stream_event" &&
    !!event.data &&
    typeof event.data === "object" &&
    (event.data as { type?: unknown }).type === "response_done"
  );
}

// The items the SDK streams from a model response before any of its tools
// run. Their events and pending-call receipts commit in the response's usage
// transaction; they touch no conversation history or media of their own.
const RESPONSE_ITEM_EVENT_NAMES = new Set([
  "message_output_created",
  "reasoning_item_created",
  "tool_called",
  "tool_search_called",
]);

/**
 * Whether an event may be read while the previous response's usage is still
 * settling (its items then commit with that usage). Everything else (tool
 * results, provider-hosted calls, another response, the stream end) waits
 * for the settlement first.
 */
export function responseSettlementOverlaps(event: { type: string }): boolean {
  if (event.type !== "run_item_stream_event") return false;
  const { name, item } = event as { name?: unknown; item?: { rawItem?: unknown } };
  if (typeof name !== "string" || !RESPONSE_ITEM_EVENT_NAMES.has(name)) return false;
  const raw = item?.rawItem;
  // Provider-hosted calls carry results and media of their own.
  return !(
    raw &&
    typeof raw === "object" &&
    (raw as { type?: unknown }).type === "hosted_tool_call"
  );
}

// The run-item event the SDK streams for each kind of response item.
const RESPONSE_ITEM_EVENT_NAME_BY_TYPE: Record<string, string> = {
  message_output_item: "message_output_created",
  reasoning_item: "reasoning_item_created",
  tool_call_item: "tool_called",
  tool_search_call_item: "tool_search_called",
};

/**
 * The items of one model response that commit in the same append as its
 * usage: the consumer collects them while the usage is prepared, and the
 * settlement takes them once closed. It closes when the consumer has read
 * every such item the SDK streamed for the response (reported before any of
 * its tools may run), or earlier at any other event, the stream end or a
 * failure; items read after that commit on their own.
 */
export function createResponseItemBundle<Event, Mutation>() {
  const events: Event[] = [];
  const mutations: Mutation[] = [];
  const callIds: string[] = [];
  const read = new Set<object>();
  let expected: Set<object> | null = null;
  let open = true;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = () => {
    if (!open) return;
    open = false;
    resolveClosed();
  };
  return {
    events,
    mutations,
    callIds,
    closed,
    isOpen: () => open,
    /** Consumer: an item of this response was collected. */
    read: (item: object) => {
      read.add(item);
      if (expected?.delete(item) && expected.size === 0) close();
    },
    /** Producer: the SDK streamed this response's items, before its tools. */
    streamed: (items: readonly unknown[]) => {
      if (!open) return;
      expected = new Set(
        items.filter(
          (item): item is object =>
            !!item &&
            typeof item === "object" &&
            !read.has(item) &&
            responseSettlementOverlaps({
              type: "run_item_stream_event",
              name: RESPONSE_ITEM_EVENT_NAME_BY_TYPE[(item as { type?: string }).type ?? ""],
              item,
            } as { type: string }),
        ),
      );
      if (expected.size === 0) close();
    },
    close,
  };
}

export type ResponseItemBundle<Event, Mutation> = ReturnType<
  typeof createResponseItemBundle<Event, Mutation>
>;

/** SDK producer/consumer rendezvous. Usage stays on the sole consumer writer. */
export function createModelCallAdmission(input: {
  signal: AbortSignal;
  admit: () => Promise<void>;
  /** Diagnostic timing of the producer side; never fences or fails a call. */
  observe?: (phase: "settlement_wait" | "admission", durationSeconds: number) => void;
  now?: () => number;
}) {
  const now = input.now ?? (() => performance.now());
  const observe = (phase: "settlement_wait" | "admission", startedAt: number) => {
    try {
      input.observe?.(phase, (now() - startedAt) / 1_000);
    } catch {
      // Diagnostics must never affect admission.
    }
  };
  type Receipt = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  const receipts = new WeakMap<object, Receipt>();
  const responseReceipts = new Map<string, Receipt>();
  const pending = new Set<Receipt>();
  // Tool calls the consumer has made durable (pending-call receipt and
  // agent.toolCall.created committed), keyed by call id. The producer awaits
  // them before any tool of the response runs. Either side may come first.
  const toolCallReceipts = new Map<string, Receipt & { settled: boolean }>();
  const toolCallReceipt = (callId: string) => {
    let receipt = toolCallReceipts.get(callId);
    if (!receipt) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => undefined);
      const created: Receipt & { settled: boolean } = {
        promise,
        settled: false,
        resolve: () => {
          created.settled = true;
          resolve();
        },
        reject,
      };
      receipt = created;
      toolCallReceipts.set(callId, receipt);
    }
    return receipt;
  };
  const responseId = (event: unknown): string | null => {
    const id = (event as { response?: { id?: unknown } } | null)?.response?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  };
  let latest: Promise<void> = Promise.resolve();
  // The admission the model call now in flight received. The SDK model wrapper
  // asks at model entry, then the transport and its dispatch checkpoint ask
  // again before the same request reaches the wire. One call needs one
  // admission: the later checks join it instead of re-running every database
  // check. A new model entry, a registered response or a failure retires it.
  let currentCallAdmission: Promise<void> | null = null;
  let failure: unknown;
  let failed = false;
  let rejectHalted!: (error: unknown) => void;
  const halted = new Promise<never>((_, reject) => {
    rejectHalted = reject;
  });
  void halted.catch(() => undefined);
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
    currentCallAdmission = null;
    rejectHalted(error);
    for (const receipt of pending) receipt.reject(error);
    pending.clear();
    responseReceipts.clear();
    for (const receipt of toolCallReceipts.values()) receipt.reject(error);
    toolCallReceipts.clear();
  };
  const abort = () => fail(input.signal.reason ?? new Error("Model stream cancelled"));
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  return {
    beforeModelRequest: async (point: "model_entry" | "transport" = "model_entry") => {
      const waitStartedAt = now();
      await Promise.race([latest, halted]);
      if (failed) throw failure;
      if (point === "model_entry") observe("settlement_wait", waitStartedAt);
      // Even a settled predecessor does not grant admission to the next call:
      // every model entry revalidates, and so does a transport check with no
      // admission of its own call to join.
      let admission = point === "transport" ? currentCallAdmission : null;
      if (!admission) {
        const admissionStartedAt = now();
        admission = input.admit().then(() => observe("admission", admissionStartedAt));
        currentCallAdmission = admission;
        const issued = admission;
        void issued.catch(() => {
          if (currentCallAdmission === issued) currentCallAdmission = null;
        });
      }
      await Promise.race([admission, halted]);
      if (failed) throw failure;
    },
    onModelResponse: (event: StreamEvent): Promise<void> => {
      if (failed) return Promise.reject(failure);
      // The response consumed its call's admission; the next call needs a new one.
      currentCallAdmission = null;
      const id = responseId(event);
      const existing =
        receipts.get(event) ??
        (id ? responseReceipts.get(id) : undefined) ??
        (!id && pending.size === 1 ? pending.values().next().value : undefined);
      if (existing) return existing.promise;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // The next model entry awaits this receipt; rejection can happen sooner.
      void promise.catch(() => undefined);
      const receipt = { promise, resolve, reject };
      receipts.set(event, receipt);
      if (id) responseReceipts.set(id, receipt);
      pending.add(receipt);
      latest = promise;
      return promise;
    },
    settle: (event: { type: string; data?: unknown }) => {
      if (event.type !== "raw_model_stream_event" || !event.data || typeof event.data !== "object")
        return;
      if ((event.data as { type?: unknown }).type !== "response_done") return;
      const id = responseId(event.data);
      // Runner retry normalization copies response_done. It cannot create a
      // second response before this receipt permits the next model entry.
      const receipt =
        receipts.get(event.data) ??
        (id ? responseReceipts.get(id) : undefined) ??
        (pending.size === 1 ? pending.values().next().value : undefined);
      if (!receipt) return;
      pending.delete(receipt);
      if (id) responseReceipts.delete(id);
      receipt.resolve();
    },
    /** Consumer: this call's pending receipt and created event are durable. */
    toolCallDurable: (callId: string) => {
      if (failed) return;
      toolCallReceipt(callId).resolve();
    },
    /**
     * Producer: wait until every listed call of a response is durable, before
     * any of its tools runs. Fails with the stream's failure instead.
     */
    awaitToolCallsDurable: async (callIds: readonly string[]): Promise<void> => {
      if (callIds.length === 0) return;
      if (failed) throw failure;
      const waiting = callIds.map((callId) => toolCallReceipt(callId));
      if (waiting.some((receipt) => !receipt.settled)) {
        await Promise.race([Promise.all(waiting.map((receipt) => receipt.promise)), halted]);
      }
      if (failed) throw failure;
      // A call id is gated once; a later response reusing it registers anew.
      for (const callId of callIds) toolCallReceipts.delete(callId);
    },
    fail,
    close: () => {
      input.signal.removeEventListener("abort", abort);
      if (pending.size > 0) fail(new Error("Model stream closed before response settlement"));
      // A producer still waiting for a call's durability can never be released
      // by a closed consumer; its tools must not run.
      if ([...toolCallReceipts.values()].some((receipt) => !receipt.settled))
        fail(new Error("Model stream closed before tool-call durability"));
      responseReceipts.clear();
      toolCallReceipts.clear();
    },
  };
}
