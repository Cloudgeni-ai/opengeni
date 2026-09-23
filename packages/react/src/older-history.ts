/**
 * Await-compatible older-history result with a causal commit receipt.
 *
 * `committed` flips synchronously before the accepted older window is exposed
 * to React. Returning this exact object preserves the receipt directly;
 * synchronous wrappers that discard it remain supported through receipt
 * capture, while replacing it asynchronously with a plain promise does not.
 */
export type OlderHistoryLoadReceipt = Promise<boolean> & {
  readonly committed: boolean;
  readonly tailPreserved?: boolean;
};

/**
 * Source-compatible public callback accepted by MessageTimeline.
 *
 * The callback historically returned `void`, which permits consumers to
 * return any synchronous value or promise. Receipt-aware loaders opt into the
 * stronger runtime contract by returning (or synchronously creating through a
 * wrapper) an {@link OlderHistoryLoadReceipt}.
 */
export type OlderHistoryLoader = () => unknown;

type MutableOlderHistoryLoadReceipt = Promise<boolean> & {
  committed: boolean;
  tailPreserved: boolean;
};

type OlderHistoryReceiptCapture = (receipt: OlderHistoryLoadReceipt) => void;

let activeReceiptCapture: OlderHistoryReceiptCapture | undefined;
let preserveTailForAutomaticLoad = false;

/** Bind a receipt before a synchronous forwarding stack can publish state. */
export function invokeOlderHistoryLoaderWithReceiptCapture(
  load: OlderHistoryLoader,
  capture: OlderHistoryReceiptCapture,
  preserveTail = false,
): unknown {
  const previousCapture = activeReceiptCapture;
  const previousPreserveTail = preserveTailForAutomaticLoad;
  activeReceiptCapture = capture;
  preserveTailForAutomaticLoad = preserveTail;
  try {
    return load();
  } finally {
    activeReceiptCapture = previousCapture;
    preserveTailForAutomaticLoad = previousPreserveTail;
  }
}

/**
 * Build an await-compatible older-history receipt for custom timeline hosts.
 * Call `markCommitted` immediately before publishing an accepted older window.
 */
export function createOlderHistoryLoadReceipt(
  load: (
    markCommitted: () => void,
    preserveTail: boolean,
    markTailPreserved: () => void,
  ) => boolean | Promise<boolean>,
): OlderHistoryLoadReceipt {
  let resolveResult!: (value: boolean | PromiseLike<boolean>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<boolean>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  }) as MutableOlderHistoryLoadReceipt;
  result.committed = false;
  result.tailPreserved = false;
  activeReceiptCapture?.(result);
  try {
    const loaded = load(
      () => {
        result.committed = true;
      },
      preserveTailForAutomaticLoad,
      () => {
        result.tailPreserved = true;
      },
    );
    Promise.resolve(loaded).then(resolveResult, rejectResult);
  } catch (error) {
    rejectResult(error);
  }
  return result;
}
