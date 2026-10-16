import type { StreamEvent } from "@openai/agents";

/** SDK producer/consumer rendezvous. Usage stays on the sole consumer writer. */
export function createModelCallAdmission(input: {
  signal: AbortSignal;
  admit: () => Promise<void>;
}) {
  type Receipt = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  const receipts = new WeakMap<object, Receipt>();
  const responseReceipts = new Map<string, Receipt>();
  const pending = new Set<Receipt>();
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
  };
  const abort = () => fail(input.signal.reason ?? new Error("Model stream cancelled"));
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  return {
    beforeModelRequest: async (point: "model_entry" | "transport" = "model_entry") => {
      await Promise.race([latest, halted]);
      if (failed) throw failure;
      // Even a settled predecessor does not grant admission to the next call:
      // every model entry revalidates, and so does a transport check with no
      // admission of its own call to join.
      let admission = point === "transport" ? currentCallAdmission : null;
      if (!admission) {
        admission = input.admit();
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
    fail,
    close: () => {
      input.signal.removeEventListener("abort", abort);
      if (pending.size > 0) fail(new Error("Model stream closed before response settlement"));
      responseReceipts.clear();
    },
  };
}
